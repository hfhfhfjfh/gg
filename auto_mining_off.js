const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://starx-network-default-rtdb.firebaseio.com"
});

const db = admin.database();
const usersRef = db.ref('users');

const MINING_DURATION_MS = 24 * 60 * 60 * 1000;
const BASE_COINS_PER_HOUR = 0.3125;
const BOOST_PER_REFERRAL = 0.0300;

async function getFirebaseServerTime(db) {
  const ref = db.ref('serverTimeForScript');
  await ref.set(admin.database.ServerValue.TIMESTAMP);
  const snap = await ref.once('value');
  return snap.val();
}

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

async function processMiningUsers(now, snapshot) {
  const updates = [];
  let miningEndedCount = 0;
  let miningActiveCount = 0;
  let totalCredited = 0;

  for (const [uid, userData] of Object.entries(snapshot.val() || {})) {
    const mining = userData.mining;
    if (mining && mining.isMining && mining.startTime) {
      const lastUpdate = mining.lastUpdate || mining.startTime;
      const miningEndTime = mining.startTime + MINING_DURATION_MS;
      const creditUntil = Math.min(now, miningEndTime);

      let elapsedMinutes;
      const isMiningDone = creditUntil >= miningEndTime;

      if (isMiningDone) {
        elapsedMinutes = Math.floor((miningEndTime - lastUpdate) / (60 * 1000));
      } else {
        elapsedMinutes = Math.round((creditUntil - lastUpdate) / (60 * 1000));
      }

      if (elapsedMinutes > 0) {
        let speedBoost = 0.0;
        if (userData.referralCode) {
          speedBoost = await getActiveReferralCount(userData.referralCode) * BOOST_PER_REFERRAL;
        }

        // ✅ Include user’s custom boostRate if available
        const boostRate = Number(userData.boostRate) || 0.0;
        const totalBoost = speedBoost + boostRate;

        const coinsPerMinute = (BASE_COINS_PER_HOUR + totalBoost) / 60.0;
        const coinsToAdd = elapsedMinutes * coinsPerMinute;
        const prevBalance = Number(userData.balance) || 0;
        const newBalance = prevBalance + coinsToAdd;

        const updateData = {
          balance: newBalance,
          'mining/lastUpdate': creditUntil,
        };

        if (isMiningDone) {
          updateData['mining/isMining'] = false;
          miningEndedCount++;
        } else {
          miningActiveCount++;
        }

        updates.push(usersRef.child(uid).update(updateData));
        totalCredited += coinsToAdd;

        console.log(
          `User ${uid}: Credited ${coinsToAdd.toFixed(5)} coins (boost: ${totalBoost.toFixed(4)} [ref:${speedBoost.toFixed(4)}, rate:${boostRate.toFixed(4)}]), minutes: ${elapsedMinutes}, mining ${isMiningDone ? 'ended' : 'continues'}.`
        );
      }
    }
  }

  await Promise.all(updates);
  
  console.log('Mining rewards crediting completed');
  console.log(`✅ Mining ended for: ${miningEndedCount} users`);
  console.log(`⛏️ Still mining: ${miningActiveCount} users`);
  console.log(`💰 Total credited: ${totalCredited.toFixed(5)} coins`);
  
  return { miningEndedCount, miningActiveCount, totalCredited };
}

async function main() {
  const now = await getFirebaseServerTime(db);
  const snapshot = await usersRef.once('value');

  console.log('=== Processing Mining Users ===');
  const miningResults = await processMiningUsers(now, snapshot);
  
  console.log('\n=== Summary ===');
  console.log(`Active miners: ${miningResults.miningActiveCount}`);
  console.log(`Mining sessions ended: ${miningResults.miningEndedCount}`);
  console.log(`Total coins credited: ${miningResults.totalCredited.toFixed(5)}`);
  
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
