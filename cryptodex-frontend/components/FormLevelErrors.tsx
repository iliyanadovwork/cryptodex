import isEmpty from "@/lib/isEmpty";

/**
 * THE ERRORS NOBODY RENDERS.
 *
 * Every auth form here draws its errors the same way: `<p>{error?.email}</p>`
 * beside the email input, `<p>{error?.password}</p>` beside the password. That
 * covers exactly the keys someone remembered to write a `<p>` for. Any other
 * key in the error object — from a validation rule with no input to point at,
 * or straight off a 400 response body — lands in state and is drawn NOWHERE.
 *
 * An error nobody renders is indistinguishable from no error at all, and the
 * symptom is not a subtle one: the submit handler runs, decides the form is
 * invalid, returns, and the button appears completely dead. That is precisely
 * how registration broke. `errors.reCaptcha` was set on every single submit
 * once the reCAPTCHA provider stopped mounting on localhost, and because the
 * Register form had no `<p>` for `reCaptcha`, a new user clicking Register saw
 * literally nothing happen — no request, no message, no clue.
 *
 * So: name the keys a form draws itself, and let this render everything else.
 * A form can still be wrong, but it can no longer be wrong in silence.
 */
export interface FormLevelErrorsProps {
  /** The form's error state object. */
  error: Record<string, any> | null | undefined;
  /** Keys this form already renders next to their own input. */
  fieldKeys: string[];
  testId?: string;
}

export default function FormLevelErrors({
  error,
  fieldKeys,
  testId = "form-level-error",
}: FormLevelErrorsProps) {
  const orphaned = Object.keys(error || {}).filter(
    (key) => !fieldKeys.includes(key) && !isEmpty((error as any)[key])
  );
  if (orphaned.length === 0) return null;
  return (
    <p className="text-danger" data-testid={testId}>
      {orphaned.map((key) => (error as any)[key]).join(" ")}
    </p>
  );
}
