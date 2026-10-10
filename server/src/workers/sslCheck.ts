import tls from 'tls';

export interface SslCheckResult {
  valid: boolean;
  daysRemaining: number;
  expiryDate: string;
  issuer: string;
  error?: string;
}

/**
 * Check the SSL certificate of a host using a TLS connection.
 * Returns certificate info (valid, daysRemaining, expiryDate, issuer).
 * Reusable across HttpMonitorWorker, JsonApiMonitorWorker, and SslMonitorWorker.
 */
export function checkSslCertificate(
  hostname: string,
  port: number = 443,
  timeoutMs: number = 10000,
): Promise<SslCheckResult> {
  return new Promise<SslCheckResult>((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        valid: false,
        daysRemaining: -1,
        expiryDate: '',
        issuer: '',
        error: `SSL check timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        rejectUnauthorized: false, // We check the cert ourselves
      },
      () => {
        clearTimeout(timer);
        const cert = socket.getPeerCertificate(true);
        socket.destroy();

        // getPeerCertificate() can return an empty object {} when no cert is available
        if (!cert || !cert.valid_to || Object.keys(cert).length === 0) {
          resolve({
            valid: false,
            daysRemaining: -1,
            expiryDate: '',
            issuer: '',
            error: 'No SSL certificate found',
          });
          return;
        }

        const expiryDate = new Date(cert.valid_to);
        const now = new Date();
        const daysRemaining = Math.floor(
          (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        );

        const issuer = cert.issuer
          ? Object.entries(cert.issuer)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')
          : 'Unknown';

        resolve({
          valid: daysRemaining >= 0,
          daysRemaining,
          expiryDate: expiryDate.toISOString().split('T')[0],
          issuer,
        });
      },
    );

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        valid: false,
        daysRemaining: -1,
        expiryDate: '',
        issuer: '',
        error: `SSL error: ${err.message}`,
      });
    });
  });
}
