const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://starx-network-default-rtdb.firebaseio.com"
});

const db = admin.database();
const usersRef = db.ref('users');

const MINING_DURATION_MS = 24 * 60 * 60 * 1000;
const BASE_COINS_PER_HOUR = 2.0;
const BOOST_PER_REFERRAL = 0.25;

async function getActiveReferralCount(referralCode) {
  if (!referralCode) return 0;
  const usersSnap = await usersRef.orderByChild('referredBy').equalTo(referralCode).once('value');
  let count = 0;
  usersSnap.forEach(child => {
    const mining = child.child('mining').val();
    if (mining && mining.isMining) count++;
  });
  return count;
}

async function main() {
  const snapshot = await usersRef.once('value');
  const now = Date.now();
  const updates = [];

  for (const [uid, userData] of Object.entries(snapshot.val() || {})) {
    const mining = userData.mining;
    if (
      mining &&
      mining.isMining &&
      mining.startTime &&
      (now - mining.startTime > MINING_DURATION_MS)
    ) {
      let lastUpdate = mining.lastUpdate || mining.startTime;
      const miningEndTime = mining.startTime + MINING_DURATION_MS;
      const elapsedMinutes = Math.floor((miningEndTime - lastUpdate) / (60 * 1000));
      if (elapsedMinutes > 0) {
        let speedBoost = 0.0;
        if (userData.referralCode) {
          speedBoost = await getActiveReferralCount(userData.referralCode) * BOOST_PER_REFERRAL;
        }
        const coinsPerMinute = (BASE_COINS_PER_HOUR + speedBoost) / 60.0;
        const coinsToAdd = elapsedMinutes * coinsPerMinute;
        const prevBalance = Number(userData.balance) || 0;
        const newBalance = prevBalance + coinsToAdd;

        updates.push(
          usersRef.child(uid).update({
            balance: newBalance,
            'mining/isMining': false,
            'mining/lastUpdate': miningEndTime,
          })
        );
        console.log(
          `User ${uid}: Credited ${coinsToAdd.toFixed(5)} coins (boost: ${speedBoost}), turned off mining.`
        );
      } else {
        updates.push(
          usersRef.child(uid).child('mining/isMining').set(false)
        );
        console.log(`User ${uid}: Mining turned off (no coins to credit).`);
      }
    }
  }

  await Promise.all(updates);
  console.log('Mining sessions auto-off and credit completed');
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
