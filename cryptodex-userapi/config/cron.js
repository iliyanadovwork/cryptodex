// import package
import cron from 'node-cron';

// import config
import config from './index.js';

// import models
import {
  User,
  UserKyc,
  UserSetting,
} from '../models/index.js';

/**
 * Delete unactivated accounts after 3 minutes
 * Runs every minute to clean up accounts that:
 * - Have status: "unverified"
 * - Were created more than 3 minutes ago
 *
 * Also cleans up related records: KYC and UserSetting
 */
export const cleanupUnactivatedAccounts = cron.schedule(
  "* * * * *",
  async () => {
    if (config.RUN_CRON !== "true") return;

    try {
      // Find accounts where status is "unverified" and createdAt is older than 3 minutes
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);

      const unactivatedUsers = await User.find({
        emailStatus: "unverified",
        createdAt: { $lt: threeMinutesAgo },
      }).select('_id');

      if (unactivatedUsers.length === 0) return;

      const userIds = unactivatedUsers.map(u => u._id);

      // Delete related records first
      await UserKyc.deleteMany({ _id: { $in: userIds } });
      await UserSetting.deleteMany({ _id: { $in: userIds } });
      // Delete the users
      const result = await User.deleteMany({
        _id: { $in: userIds },
      });

      console.log(
        `[CLEANUP] Deleted ${result.deletedCount} unactivated account(s) and related records older than 3 minutes`
      );
    } catch (err) {
      console.error("[CLEANUP] Error deleting unactivated accounts:", err);
    }
  },
  {
    scheduled: false,
  }
);
