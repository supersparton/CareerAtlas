"use client";

import React, { useRef } from "react";
import { motion, useScroll, useTransform } from "framer-motion";

interface ScrollRevealProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  direction?: "up" | "down" | "left" | "right";
  distance?: number;
}

export function ScrollReveal({
  children,
  className = "",
  delay = 0,
  direction = "up",
  distance = 50,
}: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["0 0.98", "0.15 0.75"],
  });

  const opacity = useTransform(scrollYProgress, [0, 1], [0, 1]);
  
  let initialX = 0;
  let initialY = 0;
  if (direction === "up") initialY = distance;
  if (direction === "down") initialY = -distance;
  if (direction === "left") initialX = distance;
  if (direction === "right") initialX = -distance;

  const y = useTransform(scrollYProgress, [0, 1], [initialY, 0]);
  const x = useTransform(scrollYProgress, [0, 1], [initialX, 0]);
  const filter = useTransform(scrollYProgress, [0, 1], ["blur(10px)", "blur(0px)"]);

  return (
    <motion.div
      ref={ref}
      style={{
        opacity,
        x,
        y,
        filter,
      }}
      transition={{ duration: 0.7, delay, ease: [0.25, 0.1, 0.25, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function ScrollTextReveal({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["0 0.95", "0.20 0.60"],
  });

  const words = text.split(" ");

  // Pre-compute all transforms outside the render loop to comply with Rules of Hooks
  const wordOpacities = words.map((_, i) => {
    const start = i / words.length;
    const end = start + 1 / words.length;
    return useTransform(scrollYProgress, [start, end], [0.6, 1]);
  });
  const wordYs = words.map((_, i) => {
    const start = i / words.length;
    const end = start + 1 / words.length;
    return useTransform(scrollYProgress, [start, end], [8, 0]);
  });
  const wordBlurs = words.map((_, i) => {
    const start = i / words.length;
    const end = start + 1 / words.length;
    return useTransform(scrollYProgress, [start, end], ["blur(2px)", "blur(0px)"]);
  });

  return (
    <div ref={containerRef} className={`py-6 md:py-10 text-center max-w-5xl mx-auto px-6 ${className}`}>
      <p className="text-2xl sm:text-4xl md:text-5xl font-extrabold tracking-tight leading-tight flex flex-wrap justify-center gap-x-3 gap-y-2.5">
        {words.map((word, i) => {
          const isBuiltForPrecision = word.toLowerCase().includes("built") || word.toLowerCase().includes("precision");

          return (
            <motion.span
              key={i}
              style={{
                opacity: wordOpacities[i],
                y: wordYs[i],
                filter: wordBlurs[i],
              }}
              className={`inline-block transition-all ${
                isBuiltForPrecision
                  ? "italic font-black text-[#664930] bg-[linear-gradient(180deg,transparent_70%,#FFDBBB_70%)] px-1 rounded-xs"
                  : "text-[#997E67]"
              }`}
            >
              {word}
            </motion.span>
          );
        })}
      </p>
    </div>
  );
}
