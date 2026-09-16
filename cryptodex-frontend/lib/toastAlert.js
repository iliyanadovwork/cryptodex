import { toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

import styles from "@/styles/common.module.css";


/**
 * `options` is a small escape hatch, added for ONE case and deliberately not
 * used as a general knob: a message the user has to act on cannot share the
 * two-second life of "Copied".
 *
 * The case is pages/spot/[id].tsx telling someone that the market they asked
 * for is not listed and naming the one they are looking at instead. Two seconds
 * of that, while the chart and the book are still painting, is close enough to
 * no message at all - which was the reported defect.
 */
export function toastAlert(
  errorType,
  message,
  id = Math.random().toString(),
  // TOP_RIGHT, not TOP_CENTER. Centred, the toast landed squarely on the
  // paper-trading disclosure - measured at 1500px, the toast spanned y 18-68
  // and the banner 56-87 - so the one line that must always be readable on a
  // venue trading virtual money was the line it covered. Six call sites already
  // passed TOP_RIGHT; this makes that the default rather than the exception.
  position = "TOP_RIGHT",
  options = {}
) {
  // Only run on client side
  if (typeof window === "undefined") {
    return;
  }

  const toastId = Math.random().toString();

  const commonOptions = {
    autoClose: 2000,
    toastId: toastId,
    position: toast.POSITION[position],
    theme: "dark",
    className: `${styles.toastify_custom}`, // Apply the custom CSS class
    ...options
  };

  if (errorType === "error") {
    toast.error(message, commonOptions);
  } else if (errorType === "success") {
    toast.success(message, commonOptions);
  }
}

// export function toastAlert(
//   errorType,
//   message,
//   id = Math.random().toString(),
//   position = "TOP_CENTER"
// ) {
//   const toastId = Math.random().toString();

//   if (errorType === "error") {
//     toast.error(message, {
//       autoClose: 2000,
//       toastId: toastId,
//       position: toast.POSITION[position],
//       theme: "dark",
//     });
//   } else if (errorType === "success") {
//     toast.success(message, {
//       autoClose: 2000,
//       toastId: toastId,
//       position: toast.POSITION[position],
//       theme: "dark",
//     });
//   }
// }