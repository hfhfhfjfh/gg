const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://starx-network-default-rtdb.firebaseio.com" // <-- Replace with your Firebase project URL
});

const db = admin.database();
const usersRef = db.ref('users');
const MINING_DURATION_MS = 24 * 60 * 60 * 1000;

async function main() {
  const snapshot = await usersRef.once('value');
  const now = Date.now();
  const updates = [];

  snapshot.forEach(userSnap => {
    const mining = userSnap.child('mining').val();
    if (
      mining &&
      mining.isMining &&
      mining.startTime &&
      (now - mining.startTime > MINING_DURATION_MS)
    ) {
      // Set isMining to false
      updates.push(
        userSnap.ref.child('mining/isMining').set(false)
      );
      // Optionally: update balance here if your logic requires it
      console.log(`Auto-off mining for user: ${userSnap.key}`);
    }
  });

  await Promise.all(updates);
  console.log('Mining sessions auto-off completed');
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
