// Resend Email Service
import config from '../config/index.js';
import {
    DELIVERY_LOG_ONLY,
    DELIVERY_SEND,
    mailDeliveryMode,
    logMailInsteadOfSending,
} from './mailDelivery.js';

/**
 * Send one transactional email.
 *
 * Delivery is decided by lib/mailDelivery.js: production always goes through
 * the provider, non-production runs that opted in log the rendered mail (and
 * its activation / reset link) instead. See that module for the full rationale
 * and the production safety argument.
 *
 * Deliberately has NO retry. Every call site invokes this without awaiting it,
 * so a retry loop here would silently multiply provider traffic during exactly
 * the outage it was meant to survive. One user action == at most one POST.
 *
 * @param {string} to recipient address
 * @param {{subject?: string, template?: string}} content rendered mail
 * @returns {Promise<{delivered: boolean, mode: string, status?: number, error?: string}>}
 */
export const sendEmail = async (to, content) => {
    const mode = mailDeliveryMode();

    if (mode === DELIVERY_LOG_ONLY) {
        return logMailInsteadOfSending(to, content);
    }

    try {
        const { subject, template } = content || {};

        if (!config.RESEND.API_KEY) {
            // Distinct from a provider rejection: nothing was ever attempted.
            console.error(
                '[mail] RESEND_API_KEY is not configured - refusing to attempt delivery.'
                + ' Set DEV_EMAIL_BYPASS=true to log activation links locally instead.'
            );
            return { delivered: false, mode, error: 'not_configured' };
        }

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.RESEND.API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: config.RESEND.FROM_EMAIL,
                to: [to],
                subject: subject,
                html: template,
            }),
        });

        if (!response.ok) {
            // Read the provider's reason and surface it at error level. Callers
            // never await us, so this log is the only place an outage is
            // visible - it must say WHICH failure it was (429 quota / rate
            // limit vs 403 unverified sending domain vs 401 bad key).
            let detail = '';
            try {
                detail = JSON.stringify(await response.json());
            } catch (parseErr) {
                detail = '(unparseable provider response)';
            }
            console.error(
                `[mail] provider rejected send to ${to}: HTTP ${response.status} ${detail}`
            );
            return { delivered: false, mode, status: response.status, error: detail };
        }

        const data = await response.json();
        return { delivered: true, mode, status: response.status, id: data && data.id };
    }
    catch (err) {
        // Never reject: callers are fire-and-forget, so a rejection here would
        // become an unhandled rejection rather than a handled failure.
        console.error(`[mail] send to ${to} failed: ${err && err.message}`);
        return { delivered: false, mode, error: err && err.message };
    }
}

export { DELIVERY_LOG_ONLY, DELIVERY_SEND, mailDeliveryMode };
