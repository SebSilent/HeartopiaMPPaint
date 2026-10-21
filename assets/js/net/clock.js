/*
 * Room clock.
 *
 * Multiplayer Piano keeps everyone in step by constantly exchanging timestamp
 * messages and trusting the round-trip with the lowest latency. We do the same:
 * the room's authority stamps its own Date.now() into a `time` reply, we work
 * out the offset between our wall clock and theirs, and every remote event is
 * interpreted on *that* clock. The result is that two people watching the same
 * stroke see it happen at the same room-time, instead of each seeing it when
 * their packet happened to land.
 */

export class RoomClock {
  constructor() {
    this.offset = 0; // roomTime = localTime + offset
    this.rtt = Infinity; // best round trip seen so far
    this.samples = 0;
    this.syncedAt = 0;
  }

  /** Local wall clock, expressed in room time. */
  now() {
    return Date.now() + this.offset;
  }

  /**
   * Called when the matching reply arrives.
   * @param {number} reqLocal  our Date.now() when the request left
   * @param {number} authTime  the authority's Date.now() when it replied
   * @param {number} recvLocal our Date.now() now
   */
  applyReply(reqLocal, authTime, recvLocal) {
    const rtt = Math.max(0, recvLocal - reqLocal);
    const estimate = reqLocal + rtt / 2; // our clock at the instant they stamped
    const offset = authTime - estimate;
    this.samples++;
    this.syncedAt = recvLocal;

    if (rtt <= this.rtt) {
      // Best sample so far: take it whole.
      this.rtt = rtt;
      this.offset = offset;
    } else {
      // Worse sample: nudge gently so a noisy path cannot jerk the clock.
      const alpha = 0.15;
      this.offset = this.offset * (1 - alpha) + offset * alpha;
    }
    return { rtt, offset };
  }

  /** Rounded one-way latency, for the HUD. */
  get latencyMs() {
    return Number.isFinite(this.rtt) ? Math.round(this.rtt / 2) : null;
  }

  get synced() {
    return this.samples > 0 && Date.now() - this.syncedAt < 15000;
  }

  reset() {
    this.offset = 0;
    this.rtt = Infinity;
    this.samples = 0;
  }
}
