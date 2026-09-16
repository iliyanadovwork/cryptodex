/**
 * User Fixtures
 *
 * Sample user data for testing
 */

export const TEST_USERS = {
  verifiedUser: {
    _id: 'USER_1',
    email: 'verified@cryptodex.com',
    firstName: 'John',
    lastName: 'Doe',
    password: '$2b$10$abcdefghijklmnopqrstuvwxyz123456', // mock bcrypt
    twoFactorSecret: null,
    twoFactorEnabled: false,
    isVerified: true,
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  unverifiedUser: {
    _id: 'USER_2',
    email: 'unverified@cryptodex.com',
    firstName: 'Jane',
    lastName: 'Smith',
    password: '$2b$10$abcdefghijklmnopqrstuvwxyz123456',
    twoFactorSecret: null,
    twoFactorEnabled: false,
    isVerified: false,
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  twoFactorUser: {
    _id: 'USER_3',
    email: '2fa@cryptodex.com',
    firstName: 'Bob',
    lastName: 'Johnson',
    password: '$2b$10$abcdefghijklmnopqrstuvwxyz123456',
    twoFactorSecret: 'JBSWY3DPEHPK3PXP',
    twoFactorEnabled: true,
    isVerified: true,
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  suspendedUser: {
    _id: 'USER_4',
    email: 'suspended@cryptodex.com',
    firstName: 'Alice',
    lastName: 'Williams',
    password: '$2b$10$abcdefghijklmnopqrstuvwxyz123456',
    twoFactorSecret: null,
    twoFactorEnabled: false,
    isVerified: true,
    status: 'suspended',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  },
  adminUser: {
    _id: 'ADMIN_1',
    email: 'admin@cryptodex.com',
    firstName: 'Admin',
    lastName: 'User',
    password: '$2b$10$abcdefghijklmnopqrstuvwxyz123456',
    twoFactorSecret: null,
    twoFactorEnabled: false,
    isVerified: true,
    status: 'active',
    role: 'admin',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01')
  }
};

export const VALID_CREDENTIALS = {
  email: 'verified@cryptodex.com',
  password: 'Password123!'
};

export const INVALID_CREDENTIALS = {
  email: 'nonexistent@cryptodex.com',
  password: 'WrongPassword123!'
};

export const NEW_USER_DATA = {
  email: 'newuser@cryptodex.com',
  firstName: 'New',
  lastName: 'User',
  password: 'NewPassword123!',
  confirmPassword: 'NewPassword123!'
};
