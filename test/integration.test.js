const createPostgresSubscriber = require("../src/index")
const {expect} = require('chai')
// Need to require `pg` like this to avoid ugly error message
const pg = require("pg")

const debug = require('debug')("pg-listen:test")
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

it("can connect", async () => {
  const hub = createPostgresSubscriber({ connectionString: "postgres://postgres:postgres@localhost:5432/postgres" })
  await hub.connect()
  await hub.close()
})

it("can listen and notify", async () => {
  let connectedEvents = 0
  const notifications = []
  const receivedPayloads = []

  const hub = createPostgresSubscriber({ connectionString: "postgres://postgres:postgres@localhost:5432/postgres" })

  hub.events.on("connected", () => connectedEvents++)
  hub.events.on("notification", (notification) => notifications.push(notification))
  hub.notifications.on("test", (payload) => receivedPayloads.push(payload))

  await hub.connect()

  try {
    await hub.listenTo("test")

    await hub.notify("test", { hello: "world" })
    await hub.notify("test2", "should not be received, since not subscribed to channel test2")
    await delay(200)

    expect(hub.getSubscribedChannels()).to.be.eql(["test"])
    expect(notifications).to.be.eql([
      {
        channel: "test",
        payload: { hello: "world" },
        processId: notifications[0].processId
      }
    ])
    expect(receivedPayloads).to.be.eql([
      { hello: "world" }
    ])
    expect(connectedEvents).to.be.eql(1)
  } finally {
    await hub.close()
  }
})

it("can handle notification without payload", async () => {
  const notifications = []
  const receivedPayloads = []

  const hub = createPostgresSubscriber({ connectionString: "postgres://postgres:postgres@localhost:5432/postgres" })
  await hub.connect()

  try {
    await hub.listenTo("test")

    hub.events.on("notification", (notification) => notifications.push(notification))
    hub.notifications.on("test", (payload) => receivedPayloads.push(payload))

    await hub.notify("test")
    await delay(200)

    expect(hub.getSubscribedChannels()).to.be.eql(["test"])
    expect(notifications).to.be.eql([
      {
        channel: "test",
        payload: undefined,
        processId: notifications[0].processId
      }
    ])
    expect(receivedPayloads).to.be.eql([undefined])
  } finally {
    await hub.close()
  }
})

it("can use custom `parse` function", async () => {
  const notifications = []

  const connectionString = "postgres://postgres:postgres@localhost:5432/postgres"

  const hub = createPostgresSubscriber(
    { connectionString },
    { parse: (base64) => Buffer.from(base64, "base64").toString("utf8") }
  )
  await hub.connect()

  const client = new pg.Client({ connectionString })
  await client.connect()

  try {
    await hub.listenTo("test")
    await hub.events.on("notification", (notification) => notifications.push(notification))

    await client.query(`NOTIFY test, '${Buffer.from("I am a payload.", "utf8").toString("base64")}'`)
    await delay(200)

    expect(notifications).to.be.eql([
      {
        channel: "test",
        payload: "I am a payload.",
        processId: notifications[0].processId
      }
    ])
  } finally {
    await hub.close()
  }
})

it("getting notified after connection is terminated", async () => {
  this.timeout(4000)
  let connectedEvents = 0
  let reconnects = 0

  const notifications = []
  const receivedPayloads = []

  const connectionString = "postgres://postgres:postgres@localhost:5432/postgres"
  let client = new pg.Client({ connectionString })
  await client.connect()
  client.on('error',()=>{})

  const hub = createPostgresSubscriber(
    { connectionString: connectionString + "?ApplicationName=pg-listen-termination-test" },
    { paranoidChecking: 1000 }
  )

  hub.events.on("connected", () => connectedEvents++)
  hub.events.on("notification", (notification) => notifications.push(notification))
  hub.events.on("reconnect", () => reconnects++)
  hub.notifications.on("test", (payload) => receivedPayloads.push(payload))

  await hub.connect()

  try {
    await hub.listenTo("test")

    await delay(1000)
    debug("Terminating database backend")

    // Don't await as we kill some other connection, so the promise won't resolve (I think)
    client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND usename = current_user").catch(()=>{})
    await delay(2000)

    client = new pg.Client({ connectionString })
    await client.connect()

    debug("Sending notification...")
    await client.query(`NOTIFY test, '{"hello": "world"}';`)
    await delay(500)

    expect(hub.getSubscribedChannels()).to.be.eql(["test"])
    expect(notifications).to.be.eql([
      {
        channel: "test",
        payload: { hello: "world" },
        processId: notifications[0] ? notifications[0].processId : 0
      }
    ])
    expect(receivedPayloads).to.be.eql([
      { hello: "world" }
    ])
    expect(reconnects).to.be.eql(1)
    expect(connectedEvents).to.be.eql(2)
  } finally {
    debug("Closing the subscriber")
    await hub.close()
  }
})
