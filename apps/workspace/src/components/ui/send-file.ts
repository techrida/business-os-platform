// One file sent as a raw request body with upload progress. `fetch` cannot report upload progress,
// so this uses XMLHttpRequest. Kept apart from the components so their tests can replace it.

export interface SentFile {
  status: number;
  /** The JSON answer, or null when the body was empty or not JSON. */
  body: unknown;
}

export interface SendingFile {
  done: Promise<SentFile>;
  abort: () => void;
}

/** Thrown into `done` when the connection fails or `abort` is called. */
export class SendInterrupted extends Error {
  constructor(readonly aborted: boolean) {
    super(aborted ? 'The upload was cancelled.' : 'The upload was interrupted.');
    this.name = 'SendInterrupted';
  }
}

/**
 * POST `file` to `url` as the body, with the given headers. `onProgress` gets the fraction sent
 * (0 to 1) whenever the browser reports it. The browser sets Content-Length from the file.
 */
export function sendFile(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
): SendingFile {
  const xhr = new XMLHttpRequest();
  const done = new Promise<SentFile>((resolve, reject) => {
    xhr.open('POST', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText === '' ? null : (JSON.parse(xhr.responseText) as unknown);
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new SendInterrupted(false));
    xhr.ontimeout = () => reject(new SendInterrupted(false));
    xhr.onabort = () => reject(new SendInterrupted(true));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}
