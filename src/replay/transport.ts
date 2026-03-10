export class ReplayTransport {
  constructor(
    private endpoint: string,
    private clientToken: string,
  ) {}

  async sendSegment(
    sessionId: string,
    segment: { events: unknown[]; index: number },
  ): Promise<void> {
    const body = JSON.stringify({
      session_id: sessionId,
      segment_index: segment.index,
      events: segment.events,
    });

    const blob = new Blob([body], { type: 'application/json' });

    await fetch(
      `${this.endpoint}?session_id=${sessionId}&segment_index=${segment.index}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.clientToken}`,
        },
        body: blob,
        keepalive: true,
      },
    ).catch(() => {
      // silent — replay delivery is best-effort
    });
  }
}
