import { Injectable } from '@nestjs/common';

export interface WebhookResponse {
  status: number;
}

/**
 * The one place that talks HTTP to subscribers, kept behind a class so the
 * service can be tested without sockets.
 */
@Injectable()
export class WebhookTransport {
  async post(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<WebhookResponse> {
    const response = await fetch(url, {
      method: 'POST',
      body,
      headers,
      // A subscriber must not be able to bounce the event to another host.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is of no interest; drop it so the socket is released.
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status };
  }
}
