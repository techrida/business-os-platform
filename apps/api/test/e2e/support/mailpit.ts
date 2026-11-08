// A small client for the Mailpit REST API (v1.33: GET /api/v1/messages). Lets an e2e prove an email really
// left the outbox and reached an SMTP server, not just that a row was queued (NFR: notifications are delivered).

export interface MailpitAddress {
  Name: string;
  Address: string;
}

/** The fields of a message summary this suite reads; Mailpit returns more. */
export interface MailpitMessage {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  Created: string;
}

export interface Mailpit {
  /** Every message Mailpit holds, newest first (up to 500, plenty for one test file). */
  list(): Promise<MailpitMessage[]>;
  /** Polls until `match` finds a message or the timeout passes; throws with what WAS there on timeout. */
  waitFor(
    match: (m: MailpitMessage) => boolean,
    what: string,
    timeoutMs?: number,
  ): Promise<MailpitMessage>;
}

export function mailpit(baseUrl: string): Mailpit {
  const list = async (): Promise<MailpitMessage[]> => {
    const res = await fetch(`${baseUrl}/api/v1/messages?limit=500`);
    if (!res.ok) throw new Error(`Mailpit GET /api/v1/messages answered ${res.status}`);
    const body = (await res.json()) as { messages?: MailpitMessage[] };
    return body.messages ?? [];
  };
  return {
    list,
    async waitFor(match, what, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      let last: MailpitMessage[] = [];
      while (Date.now() < deadline) {
        last = await list();
        const found = last.find(match);
        if (found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const seen = last.map((m) => `${m.Subject} -> ${m.To.map((t) => t.Address).join(',')}`);
      throw new Error(
        `no Mailpit message for ${what} within ${timeoutMs} ms; saw: ${JSON.stringify(seen)}`,
      );
    },
  };
}
