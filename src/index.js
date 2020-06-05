"use strict";

const debug = require("debug")
const events = require("events")
const pg_format = require("pg-format")
// Need to require `pg` like this to avoid ugly error message (see #15)
const pg = require("pg");
const connectionLogger = debug("pg-listen:connection");
const notificationLogger = debug("pg-listen:notification");
const paranoidLogger = debug("pg-listen:paranoid");
const subscriptionLogger = debug("pg-listen:subscription");
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));


function connect(connectionConfig, emitter, options) {
    connectionLogger("Creating PostgreSQL client for notification streaming");
    const { retryInterval = 500, retryLimit = Infinity, retryTimeout = 3000 } = options;
    const effectiveConnectionConfig = { ...connectionConfig, keepAlive: true };
    const Client = options.native && pg.native ? pg.native.Client : pg.Client;
    const dbClient = new Client(effectiveConnectionConfig);
    const reconnect = async (onAttempt) => {
        connectionLogger("Reconnecting to PostgreSQL for notification streaming");
        const startTime = Date.now();
        for (let attempt = 1; attempt < retryLimit || !retryLimit; attempt++) {
            connectionLogger(`PostgreSQL reconnection attempt #${attempt}...`);
            onAttempt(attempt);
            try {
                const newClient = new Client(effectiveConnectionConfig);
                const connecting = new Promise((resolve, reject) => {
                    newClient.once("connect", resolve);
                    newClient.once("end", () => reject(Error("Connection ended.")));
                    newClient.once("error", reject);
                });
                await Promise.all([
                    newClient.connect(),
                    connecting
                ]);
                connectionLogger("PostgreSQL reconnection succeeded");
                return newClient;
            }
            catch (error) {
                connectionLogger("PostgreSQL reconnection attempt failed:", error);
                await delay(retryInterval);
                if (retryTimeout && (Date.now() - startTime) > retryTimeout) {
                    throw new Error(`Stopping PostgreSQL reconnection attempts after ${retryTimeout}ms timeout has been reached.`);
                }
            }
        }
        throw new Error("Reconnecting notification client to PostgreSQL database failed.");
    };
    return {
        dbClient,
        reconnect
    };
}
function forwardDBNotificationEvents(dbClient, emitter, parse) {
    const onNotification = (notification) => {
        notificationLogger(`Received PostgreSQL notification on "${notification.channel}":`, notification.payload);
        let payload;
        try {
            payload = notification.payload ? parse(notification.payload) : undefined;
        }
        catch (error) {
            error.message = `Error parsing PostgreSQL notification payload: ${error.message}`;
            return emitter.emit("error", error);
        }
        emitter.emit("notification", {
            processId: notification.processId,
            channel: notification.channel,
            payload
        });
    };
    dbClient.on("notification", onNotification);
    return function cancelNotificationForwarding() {
        dbClient.removeListener("notification", onNotification);
    };
}
function scheduleParanoidChecking(dbClient, intervalTime, reconnect) {
    const scheduledCheck = async () => {
        try {
            await dbClient.query("SELECT pg_backend_pid()");
            paranoidLogger("Paranoid connection check ok");
        }
        catch (error) {
            paranoidLogger("Paranoid connection check failed");
            connectionLogger("Paranoid connection check failed:", error);
            await reconnect();
        }
    };
    const interval = setInterval(scheduledCheck, intervalTime);
    return function unschedule() {
        clearInterval(interval);
    };
}
function createPostgresSubscriber(connectionConfig, options = {}) {
    const { paranoidChecking = 30000, parse = JSON.parse, serialize = JSON.stringify } = options;
    const emitter = new events.default();
    emitter.setMaxListeners(0); // unlimited listeners
    const notificationsEmitter = new events.default();
    notificationsEmitter.setMaxListeners(0); // unlimited listeners
    emitter.on("notification", (notification) => {
        notificationsEmitter.emit(notification.channel, notification.payload);
    });
    const { dbClient: initialDBClient, reconnect } = connect(connectionConfig, emitter, options);
    let closing = false;
    let dbClient = initialDBClient;
    let reinitializingRightNow = false;
    let subscribedChannels = [];
    let cancelEventForwarding = () => undefined;
    let cancelParanoidChecking = () => undefined;
    const initialize = (client) => {
        // Wire the DB client events to our exposed emitter's events
        cancelEventForwarding = forwardDBNotificationEvents(client, emitter, parse);
        dbClient.on("error", (error) => {
            if (!reinitializingRightNow) {
                connectionLogger("DB Client error:", error);
                reinitialize();
            }
        });
        dbClient.on("end", () => {
            if (!reinitializingRightNow) {
                connectionLogger("DB Client connection ended");
                reinitialize();
            }
        });
        if (paranoidChecking) {
            cancelParanoidChecking = scheduleParanoidChecking(client, paranoidChecking, reinitialize);
        }
    };
    // No need to handle errors when calling `reinitialize()`, it handles its errors itself
    const reinitialize = async () => {
        if (reinitializingRightNow || closing) {
            return;
        }
        reinitializingRightNow = true;
        try {
            cancelParanoidChecking();
            cancelEventForwarding();
            dbClient.removeAllListeners();
            dbClient.once("error", error => connectionLogger(`Previous DB client errored after reconnecting already:`, error));
            dbClient.end();
            dbClient = await reconnect(attempt => emitter.emit("reconnect", attempt));
            initialize(dbClient);
            subscriptionLogger(`Re-subscribing to channels: ${subscribedChannels.join(", ")}`);
            await Promise.all(subscribedChannels.map(channelName => dbClient.query(`LISTEN ${pg_format.default.ident(channelName)}`)));
            emitter.emit("connected");
        }
        catch (error) {
            error.message = `Re-initializing the PostgreSQL notification client after connection loss failed: ${error.message}`;
            connectionLogger(error.stack || error);
            emitter.emit("error", error);
        }
        finally {
            reinitializingRightNow = false;
        }
    };
    // TODO: Maybe queue outgoing notifications while reconnecting
    return {
        /** Emits events: "error", "notification" & "redirect" */
        events: emitter,
        /** For convenience: Subscribe to distinct notifications here, event name = channel name */
        notifications: notificationsEmitter,
        /** Don't forget to call this asyncronous method before doing your thing */
        async connect() {
            initialize(dbClient);
            await dbClient.connect();
            emitter.emit("connected");
        },
        close() {
            connectionLogger("Closing PostgreSQL notification listener.");
            closing = true;
            cancelParanoidChecking();
            return dbClient.end();
        },
        getSubscribedChannels() {
            return subscribedChannels;
        },
        listenTo(channelName) {
            if (subscribedChannels.indexOf(channelName) > -1) {
                return;
            }
            subscriptionLogger(`Subscribing to PostgreSQL notification "${channelName}"`);
            subscribedChannels = [...subscribedChannels, channelName];
            return dbClient.query(`LISTEN ${pg_format.default.ident(channelName)}`);
        },
        notify(channelName, payload) {
            notificationLogger(`Sending PostgreSQL notification to "${channelName}":`, payload);
            if (payload !== undefined) {
                const serialized = serialize(payload);
                return dbClient.query(`NOTIFY ${pg_format.default.ident(channelName)}, ${pg_format.default.literal(serialized)}`);
            }
            else {
                return dbClient.query(`NOTIFY ${pg_format.default.ident(channelName)}`);
            }
        },
        unlisten(channelName) {
            if (subscribedChannels.indexOf(channelName) === -1) {
                return;
            }
            subscriptionLogger(`Unsubscribing from PostgreSQL notification "${channelName}"`);
            subscribedChannels = subscribedChannels.filter(someChannel => someChannel !== channelName);
            return dbClient.query(`UNLISTEN ${pg_format.default.ident(channelName)}`);
        },
        unlistenAll() {
            subscriptionLogger("Unsubscribing from all PostgreSQL notifications.");
            subscribedChannels = [];
            return dbClient.query(`UNLISTEN *`);
        }
    };
}
module.exports = createPostgresSubscriber;
