// SMTP delivery via nodemailer. The Mailer interface lets tests and the sender stay independent of it.
import nodemailer from 'nodemailer';
import type { SettingsData } from '../core/settings.ts';

export interface OutgoingMail { to: string; toName: string; subject: string; html: string; text: string }
export interface Mailer { send(mail: OutgoingMail): Promise<void> }
export interface SmtpMailer extends Mailer { verify(): Promise<void> }

type SmtpSettings = Pick<SettingsData, 'smtpHost' | 'smtpPort' | 'smtpSecurity' | 'smtpUser' | 'smtpPassword' | 'fromEmail' | 'fromName' | 'replyTo'>;

export function createSmtpMailer(s: SmtpSettings): SmtpMailer {
  const transport = nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecurity === 'tls', // implicit TLS (port 465)
    requireTLS: s.smtpSecurity === 'starttls', // refuse to send in clear text
    ignoreTLS: s.smtpSecurity === 'none',
    auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassword } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      await transport.sendMail({
        from: { name: s.fromName, address: s.fromEmail },
        to: { name: mail.toName, address: mail.to },
        replyTo: s.replyTo || undefined,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
    async verify() { await transport.verify(); },
  };
}
