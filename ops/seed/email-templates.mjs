/**
 * Transactional e-mail templates for a fresh Cryptodex database.
 *
 * The array below is a VERBATIM extraction of lines 5-219 of
 * cryptodex-userapi/scripts/seed-email-templates.js
 * (which hardcodes `mongodb://127.0.0.1:27017/cryptodex_user` and therefore
 * cannot be pointed at a scratch database). Extracting the data lets
 * ops/reset-and-seed.mjs write the same five templates into any target
 * database without duplicating the HTML by hand.
 *
 * Identifiers consumed by the running code:
 *   activate_register_user  - auth.controller.js register / resendMail
 *   EMAIL_VERIFICATION_OTP  - e-mail OTP
 *   User_forgot             - forgot password
 *   Login_notification      - login notice
 *   Change_Password         - password changed notice
 */
export const templates = [
  {
    identifier: 'activate_register_user',
    subject: 'Verify Your Email Address',
    content: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Email Verification</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; padding: 20px 0; }
    .logo { max-width: 150px; }
    .content { background: #f5f5f5; padding: 30px; border-radius: 5px; }
    .button { display: inline-block; padding: 12px 30px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>##SITE_NAME##</h2>
    </div>
    <div class="content">
      <h3>Welcome to ##SITE_NAME##!</h3>
      <p>Hi ##templateInfo_name##,</p>
      <p>Thank you for registering with ##SITE_NAME##. To complete your registration, please verify your email address by clicking the button below:</p>
      <p><a href="##templateInfo_url##" class="button">Verify Email Address</a></p>
      <p>Or copy and paste this link into your browser:</p>
      <p>##templateInfo_url##</p>
      <p>This link will expire in 24 hours.</p>
      <p>If you didn't create an account with ##SITE_NAME##, please ignore this email.</p>
    </div>
    <div class="footer">
      <p>&copy; ##DATE## ##SITE_NAME##. All rights reserved.</p>
      <p>Need help? Contact us at ##SUPPORT_MAIL##</p>
    </div>
  </div>
</body>
</html>`,
    langCode: 'en',
    status: 'active'
  },
  {
    identifier: 'EMAIL_VERIFICATION_OTP',
    subject: 'Your Verification Code',
    content: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Email Verification OTP</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; padding: 20px 0; }
    .content { background: #f5f5f5; padding: 30px; border-radius: 5px; }
    .otp { font-size: 32px; font-weight: bold; text-align: center; padding: 20px; background: #fff; margin: 20px 0; border-radius: 5px; letter-spacing: 5px; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>##SITE_NAME##</h2>
    </div>
    <div class="content">
      <h3>Your Verification Code</h3>
      <p>Hi ##templateInfo_name##,</p>
      <p>Please use the following verification code to complete your login:</p>
      <div class="otp">##OTP##</div>
      <p>This code will expire in 3 minutes.</p>
      <p>If you didn't request this code, please ignore this email and secure your account.</p>
    </div>
    <div class="footer">
      <p>&copy; ##SITE_NAME##. All rights reserved.</p>
      <p>Need help? Contact us at ##SUPPORT_MAIL##</p>
    </div>
  </div>
</body>
</html>`,
    langCode: 'en',
    status: 'active'
  },
  {
    identifier: 'User_forgot',
    subject: 'Reset Your Password',
    content: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Reset Password</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; padding: 20px 0; }
    .content { background: #f5f5f5; padding: 30px; border-radius: 5px; }
    .button { display: inline-block; padding: 12px 30px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>##SITE_NAME##</h2>
    </div>
    <div class="content">
      <h3>Reset Your Password</h3>
      <p>Hi ##templateInfo_name##,</p>
      <p>We received a request to reset your password. Click the button below to create a new password:</p>
      <p><a href="##templateInfo_url##" class="button">Reset Password</a></p>
      <p>Or copy and paste this link into your browser:</p>
      <p>##templateInfo_url##</p>
      <p>This link will expire in 1 hour.</p>
      <p>If you didn't request a password reset, please ignore this email and secure your account.</p>
    </div>
    <div class="footer">
      <p>&copy; ##SITE_NAME##. All rights reserved.</p>
      <p>Need help? Contact us at ##SUPPORT_MAIL##</p>
    </div>
  </div>
</body>
</html>`,
    langCode: 'en',
    status: 'active'
  },
  {
    identifier: 'Login_notification',
    subject: 'New Login Detected',
    content: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Login Notification</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; padding: 20px 0; }
    .content { background: #f5f5f5; padding: 30px; border-radius: 5px; }
    .info { background: #fff; padding: 15px; margin: 10px 0; border-radius: 5px; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>##SITE_NAME##</h2>
    </div>
    <div class="content">
      <h3>New Login Detected</h3>
      <p>Hi ##templateInfo_name##,</p>
      <p>We detected a new login to your ##SITE_NAME## account:</p>
      <div class="info">
        <p><strong>Date:</strong> ##DATE##</p>
        <p><strong>Browser:</strong> ##BROWSER##</p>
        <p><strong>IP Address:</strong> ##IP##</p>
        <p><strong>Country:</strong> ##COUNTRY##</p>
      </div>
      <p>If this was you, no action is required.</p>
      <p>If you didn't login, please secure your account immediately.</p>
    </div>
    <div class="footer">
      <p>&copy; ##SITE_NAME##. All rights reserved.</p>
      <p>Need help? Contact us at ##SUPPORT_MAIL##</p>
    </div>
  </div>
</body>
</html>`,
    langCode: 'en',
    status: 'active'
  },
  {
    identifier: 'Change_Password',
    subject: 'Password Changed Successfully',
    content: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Password Changed</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; padding: 20px 0; }
    .content { background: #f5f5f5; padding: 30px; border-radius: 5px; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>##SITE_NAME##</h2>
    </div>
    <div class="content">
      <h3>Password Changed Successfully</h3>
      <p>Hi ##templateInfo_name##,</p>
      <p>Your ##SITE_NAME## password has been changed successfully.</p>
      <p>If you didn't make this change, please contact our support team immediately.</p>
      <p>Date: ##DATE##</p>
    </div>
    <div class="footer">
      <p>&copy; ##SITE_NAME##. All rights reserved.</p>
      <p>Need help? Contact us at ##SUPPORT_MAIL##</p>
    </div>
  </div>
</body>
</html>`,
    langCode: 'en',
    status: 'active'
  }
];
