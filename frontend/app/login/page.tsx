"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, ShieldCheck, ArrowRight, AlertCircle, RefreshCw, KeyRound, TrendingUp, Cpu, CheckCircle2 } from "lucide-react";
import { Skiper106Input } from "@/components/ui/skiper-ui/skiper106";
import { CareerAtlasLogoMark } from "@/components/ui/CareerAtlasLogoMark";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"EMAIL" | "OTP">("EMAIL");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [expiryTimer, setExpiryTimer] = useState<number>(0);
  const [resendCooldown, setResendCooldown] = useState<number>(0);

  // 5-minute OTP Expiry countdown
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (expiryTimer > 0) {
      interval = setInterval(() => setExpiryTimer((prev) => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [expiryTimer]);

  // 45-second Resend OTP Cooldown countdown
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (resendCooldown > 0) {
      interval = setInterval(() => setResendCooldown((prev) => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [resendCooldown]);

  const handleSendOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!email || !email.includes("@")) {
      setError("Please enter a valid Gmail / Email address.");
      return;
    }
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "Failed to send verification code.");
      }

      setStep("OTP");
      setExpiryTimer(300); // 5 minutes expiry
      setResendCooldown(45); // 45s resend cooldown
      setSuccessMsg(`Verification code sent to ${email}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Check existing session on mount
  useEffect(() => {
    async function checkSession() {
      try {
        const token = localStorage.getItem("careeratlas_token");
        if (!token) return;

        const res = await fetch("/api/auth/session", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.valid) {
            if (data.user) {
              localStorage.setItem("careeratlas_user", JSON.stringify(data.user));
            }
            router.replace("/dashboard");
          }
        }
      } catch (err) {
        // Safe fallback
      }
    }
    checkSession();
  }, [router]);

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp || otp.length !== 6) {
      setError("Please enter the complete 6-digit verification code.");
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || "Invalid verification code.");
      }

      if (data.token) {
        localStorage.setItem("careeratlas_token", data.token);
        document.cookie = `careeratlas_session=${data.token}; path=/; max-age=604800; SameSite=Lax`;
        if (data.user) {
          localStorage.setItem("careeratlas_user", JSON.stringify(data.user));
        }
      }

      router.replace("/dashboard");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <div className="min-h-screen w-full flex bg-[#FFFBF7] font-sans antialiased text-[#664930]">
      {/* LEFT SECTION: 30% Width Auth Form */}
      <div className="w-full lg:w-[32%] xl:w-[30%] flex flex-col justify-between p-6 sm:p-10 lg:p-12 z-10 bg-white border-r border-[#CCBEB1] shadow-xl">
        <div>
          <div className="flex items-center justify-between mb-10">
            <a href="/" className="flex items-center gap-3">
              <CareerAtlasLogoMark size={36} showText />
            </a>
          </div>

          <AnimatePresence mode="wait">
            {step === "EMAIL" ? (
              <motion.div
                key="email-step"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="space-y-6"
              >
                <div className="space-y-2">
                  <h1 className="text-2xl sm:text-3xl font-extrabold text-[#664930] tracking-tight font-sans">
                    Welcome back
                  </h1>
                  <p className="text-xs text-[#997E67] font-sans">
                    Sign in with your email to access your resume matches.
                  </p>
                </div>

                {error && (
                  <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                <form onSubmit={handleSendOtp} className="space-y-4">
                  <Skiper106Input
                    label="Gmail / Email Address"
                    icon={<Mail className="w-4 h-4 text-[#997E67]" />}
                    type="email"
                    required
                    placeholder="name@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 px-4 rounded-xl bg-[#664930] hover:bg-[#523a26] text-white text-sm font-semibold transition-all shadow-md flex items-center justify-center gap-2 font-sans"
                  >
                    {loading ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <span>Continue with Code</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </form>
              </motion.div>
            ) : (
              <motion.form
                key="otp-step"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                onSubmit={handleVerifyOtp}
                className="space-y-6"
              >
                <div className="space-y-2">
                  <h1 className="text-2xl font-extrabold text-[#664930] font-sans">Enter Code</h1>
                  <p className="text-xs text-[#997E67] font-sans">
                    Enter the 6-digit code sent to <strong className="text-[#664930]">{email}</strong>.
                  </p>
                </div>

                {error && (
                  <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2 font-sans">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                {successMsg && (
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-start gap-2 font-sans">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
                    <span>{successMsg}</span>
                  </div>
                )}

                <Skiper106Input
                  label="6-Digit Verification Code"
                  icon={<KeyRound className="w-4 h-4 text-[#997E67]" />}
                  type="text"
                  maxLength={6}
                  required
                  placeholder="123456"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                />

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-4 rounded-xl bg-[#664930] hover:bg-[#523a26] text-white text-sm font-semibold transition-all shadow-md flex items-center justify-center gap-2 font-sans"
                >
                  {loading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <span>Verify & Access Dashboard</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <div className="flex items-center justify-between text-xs text-[#997E67] pt-2 font-mono">
                  <span>Code expires: {formatTimer(expiryTimer)}</span>
                  <button
                    type="button"
                    onClick={() => handleSendOtp()}
                    disabled={resendCooldown > 0}
                    className="text-[#664930] font-bold hover:underline disabled:opacity-50"
                  >
                    {resendCooldown > 0 ? `Resend (${resendCooldown}s)` : "Resend Code"}
                  </button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>
        </div>

        <div className="pt-8 text-xs text-[#997E67] font-sans">
          Protected by CareerAtlas Security.
        </div>
      </div>

      {/* RIGHT SECTION: 70% Width Hero Graphic */}
      <div className="hidden lg:flex lg:w-[68%] xl:w-[70%] relative flex-col justify-between p-12 overflow-hidden bg-[#FFFBF7]">
        <div className="relative z-20 max-w-2xl my-auto space-y-6">
          <div className="space-y-4 font-sans">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 bg-[#FFDBBB] border border-[#CCBEB1] rounded-full text-xs font-bold text-[#664930]">
              <Cpu className="w-3.5 h-3.5 text-[#664930]" />
              <span>Job finding just got easier</span>
            </div>
            <h2 className="text-4xl xl:text-5xl font-extrabold text-[#664930] tracking-tight leading-tight font-sans">
              Land Your Next High-Impact Role with <span className="text-[#997E67]">AI Precision</span>.
            </h2>
            <p className="text-[#997E67] text-base leading-relaxed font-sans">
              CareerAtlas continuously scans ATS job portals, extracts skill requirements, and matches your profile against vector space embeddings in real-time.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-4 font-sans">
            <div className="p-4 bg-white border border-[#CCBEB1] rounded-2xl space-y-2 shadow-xs">
              <div className="flex items-center gap-2 text-[#664930]">
                <TrendingUp className="w-5 h-5" />
                <span className="font-bold text-sm text-[#664930]">99.4% Semantic Precision</span>
              </div>
              <p className="text-xs text-[#997E67] font-sans">Qdrant vector embeddings eliminate noisy job boards and deliver true candidate-job alignment.</p>
            </div>

            <div className="p-4 bg-white border border-[#CCBEB1] rounded-2xl space-y-2 shadow-xs">
              <div className="flex items-center gap-2 text-[#664930]">
                <ShieldCheck className="w-5 h-5" />
                <span className="font-bold text-sm text-[#664930]">Anti-Detect Scraping</span>
              </div>
              <p className="text-xs text-[#997E67] font-sans">Camoufox shared browser pooling parses JSON-LD schemas with zero latency impact.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
