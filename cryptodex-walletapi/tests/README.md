# Cryptodex Exchange - Wallet API Tests

This directory contains all tests for the Wallet API service.

## Test Structure

```
tests/
├── unit/                   # Unit tests (isolated functions/models)
│   ├── wallet.model.test.js
│   ├── currency.model.test.js
│   └── balance-calculations.test.js
├── integration/            # Integration tests (API endpoints)
│   └── wallet-api.test.js
├── e2e/                    # End-to-end tests (full workflows)
├── fixtures/               # Test data samples
│   ├── currency-fixtures.js
│   ├── user-fixtures.js
│   └── wallet-fixtures.js
├── helpers/                # Test utility functions
│   ├── test-helpers.js
│   ├── db-helpers.js
│   └── api-helpers.js
├── setup.js                # Global test setup
└── index.js                # Test exports
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run tests in verbose mode
npm run test:verbose
```

## Test Categories

### Critical Tests (Must Pass)
- **Balance Calculations** - All financial math operations
- **Withdrawal Processing** - Fund transfers out
- **Deposit Processing** - Fund transfers in
- **Fee Calculations** - All fee computations

### Important Tests
- **Authentication** - JWT validation, 2FA
- **Authorization** - Role-based access
- **Input Validation** - Sanitize all inputs

### Standard Tests
- **CRUD Operations** - Basic data operations
- **API Endpoints** - HTTP responses
- **Error Handling** - Edge cases

## Coverage Goals

| Component | Target Coverage |
|------------|-----------------|
| Controllers | 80%+ |
| Models | 90%+ |
| Services | 80%+ |
| Routes | 70%+ |
| **Overall** | **75%+** |

## Writing New Tests

1. **Unit Tests**: Test individual functions/models in isolation
2. **Integration Tests**: Test API endpoints with mocked dependencies
3. **E2E Tests**: Test complete user workflows

### Test File Template

```javascript
import { describe, test, expect } from '@jest/globals';
import { generateTestWallet } from '../index.js';

describe('Feature Name', () => {
  beforeEach(async () => {
    // Setup before each test
  });

  afterEach(async () => {
    // Cleanup after each test
  });

  test('should do something correctly', async () => {
    // Arrange
    const input = 'test';

    // Act
    const result = await someFunction(input);

    // Assert
    expect(result).toBe('expected');
  });
});
```

## Test Fixtures

Fixtures contain sample data for consistent testing:

- `SUPPORTED_CURRENCIES` - BTC, ETH, USDT, BNB, SOL
- `TEST_USERS` - Verified, unverified, 2FA, suspended users
- `TEST_WALLETS` - Various wallet states
- `TEST_TRANSACTIONS` - Completed, pending, failed transactions

## Important Notes

⚠️ **NEVER modify balance calculation tests without thorough review**
⚠️ **ALWAYS run tests before deploying to production**
⚠️ **Check coverage reports for untested critical paths**
⚠️ **Test both success and failure scenarios**

## Continuous Integration

Tests should run on:
- Every pull request
- Before merging to main
- On deployment to staging

## Troubleshooting

### Tests failing?

1. Check MongoDB connection: `mongosh --eval "db.stats()"`
2. Clear test database: `npm run test:clean` (if available)
3. Update dependencies: `npm install`
4. Clear Jest cache: `npm test --clearCache`

### MongoDB Memory Server issues?

- Ensure Node version >= 18
- Try reinstalling: `npm uninstall mongodb-memory-server && npm install`
- Check available memory on system

### Port conflicts?

Tests use random ports by default. If issues occur, check:
- No other services running on test ports
- Firewall allows localhost connections
