import { sendJson } from '../send';

export class ReplayTransport {
  constructor(
    private endpoint: string,
    private clientToken: string,
  ) {}

  /**
   * Best-effort delivery. A segment is often past the 64 KiB keepalive cap,
   * where a keepalive request is refused outright; `sendJson` sends those as
   * plain requests instead of silently dropping them.
   */
  async sendSegment(
    sessionId: string,
    segment: { events: unknown[]; index: number },
  ): Promise<void> {
    const body = JSON.stringify({
      session_id: sessionId,
      segment_index: segment.index,
      events: segment.events,
    });

    await sendJson(
      `${this.endpoint}?session_id=${sessionId}&segment_index=${segment.index}`,
      this.clientToken,
      body,
    );
  }
}
