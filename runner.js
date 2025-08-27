import { IGClient } from "./igClient.js";

export class IGRunner {
  constructor() {
    this.ig = new IGClient();
  }

  async execute(task) {
    switch (task.kind) {
      case "FOLLOW":
        return await this.ig.follow(task.userId);
      case "UNFOLLOW":
        return await this.ig.unfollow(task.userId);
      case "LIKE":
        return await this.ig.like(task.mediaId);
      case "LOOKUP":
        return await this.ig.userIdFromUsername(task.username);
      case "LIST_FOLLOWERS":
        return await this.ig.listFollowers(task);
      case "LIST_FOLLOWING":
        return await this.ig.listFollowing(task);
      case "LAST_MEDIA":
        return await this.ig.lastMediaIdFromUserId(task.userId, task.username);
      default:
        throw new Error("unknown_task");
    }
  }
}
