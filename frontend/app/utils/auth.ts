"use client";

export function getUserEmail(): string {
  if (typeof window === "undefined") return "";
  const userStr = localStorage.getItem("careeratlas_user");
  if (userStr) {
    try {
      const parsed = JSON.parse(userStr);
      if (parsed && parsed.email) return parsed.email;
    } catch {}
  }
  return localStorage.getItem("user_email") || "";
}

export function getAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = localStorage.getItem("careeratlas_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function isAuthenticated(): boolean {
  if (typeof window === "undefined") return false;
  const token = localStorage.getItem("careeratlas_token");
  return Boolean(token);
}

export async function logout(): Promise<void> {
  if (typeof window === "undefined") return;

  const token = localStorage.getItem("careeratlas_token");

  // Call backend logout to clear HTTP-Only session cookie and invalidate DB session
  // The backend's clearCookie handles removing the HttpOnly cookie — document.cookie cannot
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
    });
  } catch (e) {
    console.error("Backend logout error:", e);
  }

  // Clear all client-side auth data
  localStorage.removeItem("careeratlas_token");
  localStorage.removeItem("careeratlas_user");
  localStorage.removeItem("user_email");

  // Redirect to main landing page
  window.location.href = "/";
}
