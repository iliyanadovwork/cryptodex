import Cookies from "js-cookie";

export function setCookie(name: string, value: any, options?: any) {
  Cookies.set(name, value, { expires: 365, path: "/" });
}
export function getCookie(name: string) {
  return Cookies.get(name);
}
export function removeCookie(name: string, options?: any) {
  Cookies.remove(name, { path: "/" });
}
