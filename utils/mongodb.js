const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = process.env.DATABASE_URL;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
let client;

let db;

async function connectToDatabase() {
  if (!client) {
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
  }
  if (!db) {
    await client.connect();
    db = client.db("imb"); // Replace with your actual database name
    console.log("✅ MongoDB Connected");
  }
  return db;
}

async function overwriteDatabaseData(collectionName, data) {
  try {
    const db = await connectToDatabase();
    const collection = db.collection(collectionName);

    await collection.deleteMany({});
    if (data.length) {
      await collection.insertMany(data);
    }

    console.log(`✅ ${collectionName} updated successfully`);
  } catch (error) {
    console.error(`❌ Failed to update ${collectionName}:`, error);
  }
}

async function insertDatabaseData(collectionName, data) {
  try {
    const db = await connectToDatabase();
    const collection = db.collection(collectionName);
    if (data.length) {
      await collection.insertMany(users);
    }

    console.log(`✅ ${collectionName} updated successfully`);
  } catch (error) {
    console.error(`❌ Failed to update ${collectionName}:`, error);
  }
}

async function closeDatabaseConnection() {
  if (client) {
    await client.close();
    console.log("🔴 MongoDB Connection Closed");
  }
}

module.exports = {
  connectToDatabase,
  closeDatabaseConnection,
  overwriteDatabaseData,
  insertDatabaseData,
  client,
};
