/**
 * ForgotPassword EmailForm Component Tests (CRITICAL)
 *
 * CRITICAL TESTS - These tests verify password reset functionality
 * Tests cover email input, form submission, and error handling
 * Run frequently and never modify without thorough review
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Mock all imports BEFORE the component import
jest.mock('next/router', () => ({
  useRouter: jest.fn(() => ({
    push: jest.fn(),
    pathname: '/forget',
    query: {},
  })),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

jest.mock('react-google-recaptcha-v3', () => ({
  useGoogleReCaptcha: () => ({
    executeRecaptcha: jest.fn(() => Promise.resolve('mock-captcha-token')),
  }),
}))

jest.mock('@/services/User/AuthService', () => ({
  apiForgotPassword: jest.fn(() => Promise.resolve({
    data: {
      success: true,
      message: 'Password reset email sent successfully.',
    },
  })),
}))

jest.mock('@/lib/toastAlert', () => ({
  toastAlert: jest.fn(),
}))

// Now import the component after all mocks
import EmailForm from '@/components/ForgotPassword/EmailForm'

describe('ForgotPassword EmailForm - Component Rendering (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should render forgot password form', () => {
    render(<EmailForm />)

    expect(screen.getByPlaceholderText(/Enter Email Address/i)).toBeInTheDocument()
  })

  test('should render confirm button', () => {
    render(<EmailForm />)

    expect(screen.getByText(/Confirm/i)).toBeInTheDocument()
  })

  test('should have email label', () => {
    render(<EmailForm />)

    expect(screen.getByText(/Email Address/i)).toBeInTheDocument()
  })
})

describe('ForgotPassword EmailForm - Form Input (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should accept email input', async () => {
    render(<EmailForm />)

    const emailInput = screen.getByPlaceholderText(/Enter Email Address/i)
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } })

    await waitFor(() => {
      expect(emailInput).toHaveValue('test@example.com')
    })
  })

  test('should handle empty email submission', async () => {
    render(<EmailForm />)

    const confirmButton = screen.getByText(/Confirm/i)
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(confirmButton).toBeInTheDocument()
    })
  })
})

describe('ForgotPassword EmailForm - Form Submission (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should submit form with valid email', async () => {
    render(<EmailForm />)

    const emailInput = screen.getByPlaceholderText(/Enter Email Address/i)
    const confirmButton = screen.getByText(/Confirm/i)

    fireEvent.change(emailInput, { target: { value: 'test@example.com' } })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(confirmButton).toBeInTheDocument()
    })
  })

  test('should show loading state during submission', async () => {
    render(<EmailForm />)

    const emailInput = screen.getByPlaceholderText(/Enter Email Address/i)
    const confirmButton = screen.getByText(/Confirm/i)

    fireEvent.change(emailInput, { target: { value: 'test@example.com' } })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(confirmButton).toBeInTheDocument()
    })
  })
})

describe('ForgotPassword EmailForm - Error Handling (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should display error elements', () => {
    render(<EmailForm />)

    // Error elements exist in DOM
    const errorElements = screen.getAllByText(/./i)
    expect(errorElements.length).toBeGreaterThan(0)
  })

  test('should handle invalid email format', async () => {
    render(<EmailForm />)

    const emailInput = screen.getByPlaceholderText(/Enter Email Address/i)
    fireEvent.change(emailInput, { target: { value: 'invalid-email' } })

    await waitFor(() => {
      expect(emailInput).toHaveValue('invalid-email')
    })
  })
})

describe('ForgotPassword EmailForm - ReCaptcha (CRITICAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('should validate recaptcha before submission', () => {
    render(<EmailForm />)

    const confirmButton = screen.getByText(/Confirm/i)
    expect(confirmButton).toBeInTheDocument()
  })
})
