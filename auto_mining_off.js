const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://starx-network-default-rtdb.firebaseio.com"
});

const db = admin.database();
const usersRef = db.ref('users');

const MINING_DURATION_MS = 24 * 60 * 60 * 1000;
const BASE_COINS_PER_HOUR = 0.4167;
const BOOST_PER_REFERRAL = 0.0300;
const SLASH_RATE_PER_HOUR = 1000.1; // Same rate as base mining for inactive users

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

async function processInactiveUsers(now, snapshot) {
  const updates = [];
  let slashedUsersCount = 0;
  let totalSlashedAmount = 0;

  // TEST MODE: Only process specific UID for testing
  const TEST_UID = 'agTboyUvq3cE4aWu8CT2Po39vh42';
  
  for (const [uid, userData] of Object.entries(snapshot.val() || {})) {
    // Skip all users except the test UID
    if (uid !== TEST_UID) continue;
    const mining = userData.mining;
    const balance = Number(userData.balance) || 0;
    
    // Check if user is inactive (not mining or mining session ended)
    const isInactive = !mining || !mining.isMining;
    
    if (isInactive && balance > 0) {
      // Get last activity time - use lastUpdate if available, otherwise use when mining ended
      let lastActivityTime;
      
      if (mining && mining.lastUpdate) {
        // If user was mining before, use their last update time
        lastActivityTime = mining.lastUpdate;
      } else if (mining && mining.startTime) {
        // If user has mining data but no lastUpdate, use start time + mining duration
        lastActivityTime = mining.startTime + MINING_DURATION_MS;
      } else {
        // If no mining data, check if user has a lastSlashUpdate field
        lastActivityTime = userData.lastSlashUpdate || now; // Default to now for new users
      }

      const timeSinceLastActivity = now - lastActivityTime;
      const hoursSinceLastActivity = timeSinceLastActivity / (60 * 60 * 1000);

      // Only slash if it's been at least 1 hour since last activity
      if (hoursSinceLastActivity >= 1) {
        const hoursToSlash = Math.floor(hoursSinceLastActivity);
        const slashAmount = Math.min(hoursToSlash * SLASH_RATE_PER_HOUR, balance);
        const newBalance = Math.max(0, balance - slashAmount);

        if (slashAmount > 0) {
          const updateData = {
            balance: newBalance,
            lastSlashUpdate: now
          };

          updates.push(usersRef.child(uid).update(updateData));
          
          slashedUsersCount++;
          totalSlashedAmount += slashAmount;

          console.log(
            `User ${uid}: Slashed ${slashAmount.toFixed(5)} coins (${hoursToSlash}h inactive), balance: ${balance.toFixed(5)} → ${newBalance.toFixed(5)}`
          );
        }
      }
    }
  }

  await Promise.all(updates);
  
  console.log('Inactive user balance slashing completed (TEST MODE)');
  console.log(`⚡ Slashed ${slashedUsersCount} inactive users (UID: ${TEST_UID}), total amount: ${totalSlashedAmount.toFixed(5)} coins`);
  
  return { slashedUsersCount, totalSlashedAmount };
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

        const coinsPerMinute = (BASE_COINS_PER_HOUR + speedBoost) / 60.0;
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
          `User ${uid}: Credited ${coinsToAdd.toFixed(5)} coins (boost: ${speedBoost}), minutes: ${elapsedMinutes}, mining ${isMiningDone ? 'ended' : 'continues'}.`
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
  
  console.log('\n=== Processing Inactive Users (TEST MODE) ===');
  const slashingResults = await processInactiveUsers(now, snapshot);
  
  console.log('\n=== Summary (TEST MODE) ===');
  console.log(`Active miners: ${miningResults.miningActiveCount}`);
  console.log(`Mining sessions ended: ${miningResults.miningEndedCount}`);
  console.log(`Total coins credited: ${miningResults.totalCredited.toFixed(5)}`);
  console.log(`Inactive users slashed: ${slashingResults.slashedUsersCount}`);
  console.log(`Total coins slashed: ${slashingResults.totalSlashedAmount.toFixed(5)}`);
  console.log(`Net coin change: ${(miningResults.totalCredited - slashingResults.totalSlashedAmount).toFixed(5)}`);
  
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
