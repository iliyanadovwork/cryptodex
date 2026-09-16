# Cryptodex Email Templates

All email templates are stored in this directory. They use the Cryptodex dark theme with blue (#1d94ff) accents.

## Template Files

| File | Identifier | Purpose |
|------|------------|---------|
| `activate_register_user.html` | `activate_register_user` | Registration verification email |
| `EMAIL_VERIFICATION_OTP.html` | `EMAIL_VERIFICATION_OTP` | Login OTP email |
| `User_forgot.html` | `User_forgot` | Password reset email |
| `Login_notification.html` | `Login_notification` | Login notification |
| `Change_Password.html` | `Change_Password` | Password change notification |
| `Login_confirmation.html` | `Login_confirmation` | Login confirmation with code |
| `change_register_email.html` | `change_register_email` | Email change verification |
| `verify_new_email.html` | `verify_new_email` | New email verification |
| `User_deposit.html` | `User_deposit` | Deposit confirmation |
| `Withdraw_notification.html` | `Withdraw_notification` | Withdrawal confirmation |

## Variables Used

### Global Variables (All Templates)
- `##EMAIL_LOGO##` - Site logo URL
- `##SUPPORT_MAIL##` - Support email address
- `##SITE_NAME##` - Site name
- `##CONTACT_NO##` - Contact number
- `##ADDRESS##` - Company address
- `##SITE_URL##` - Frontend URL
- `##DATE##` - Current date
- `##ANTIPHISHINGCODE##` - User's anti-phishing code (if set)

### Template-Specific Variables

**activate_register_user.html**
- `##templateInfo_name##` - User's email
- `##templateInfo_url##` - Verification link
- `##templateInfo_appName##` - App name

**EMAIL_VERIFICATION_OTP.html**
- `##OTP##` - OTP code

**User_forgot.html**
- `##templateInfo_name##` - User's name
- `##templateInfo_url##` - Reset password link

**Login_notification.html**
- `##BROWSER##` - Browser name
- `##IP##` - IP address
- `##COUNTRY##` - Country name
- `##DATE##` - Login date

**Change_Password.html**
- `##DATE##` - Password change date

**Login_confirmation.html**
- `##CODE##` - Verification code
- `##BROWSER##` - Browser name
- `##IP##` - IP address
- `##COUNTRY##` - Country name
- `##DATE##` - Login date

**change_register_email.html**
- `##templateInfo_url##` - Verification link
- `##DATE##` - Request date

**verify_new_email.html**
- `##templateInfo_url##` - Verification link
- `##DATE##` - Request date

**User_deposit.html**
- `##AMOUNT##` - Deposit amount
- `##CURRENCY##` - Currency symbol
- `##TXID##` - Transaction ID
- `##DATE##` - Deposit date

**Withdraw_notification.html**
- `##AMOUNT##` - Withdrawal amount
- `##CURRENCY##` - Currency symbol
- `##TXID##` - Transaction ID
- `##DATE##` - Withdrawal date

## Adding Templates to Database

To add these templates to MongoDB, use the admin API:

```bash
POST /adminapi/emailTemplate
Content-Type: application/json

{
  "identifier": "activate_register_user",
  "subject": "Verify Your Email Address",
  "content": "<html>...</html>",  // Paste template content
  "langCode": "en"
}
```

Or manually insert into MongoDB:

```javascript
db.emailtemplate.insertOne({
  identifier: "activate_register_user",
  subject: "Verify Your Email Address",
  content: "<html>...</html>",
  langCode: "en",
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date()
})
```

## Color Scheme

- **Background**: `#070707` (dark)
- **Card Background**: `#0a0a0a` to `#070707` gradient
- **Border**: `#1a1919`
- **Primary Accent**: `#1d94ff` (blue)
- **Primary Gradient**: `#1d94ff` to `#0a6cc4`
- **Success**: `#14bb7b` (green)
- **Error**: `#ef5350` (red)
- **Text White**: `#ffffff`
- **Text Grey**: `#d0d0d0`
- **Text Muted**: `#999999`
