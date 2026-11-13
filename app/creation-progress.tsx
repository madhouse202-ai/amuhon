"use client";

import Link from "next/link";

const STEPS = [
  { label: "作品を選ぶ", href: "/create" },
  { label: "表紙を作る", href: "/cover" },
  { label: "完成を確認", href: "/final" },
] as const;

export function CreationProgress({
  currentStep,
  allowCompletedNavigation = true,
}: {
  currentStep: 1 | 2 | 3;
  allowCompletedNavigation?: boolean;
}) {
  return (
    <nav aria-label="本づくりの工程" className="mb-6">
      <ol className="grid grid-cols-3 gap-2 text-center text-xs sm:text-sm">
        {STEPS.map((step, index) => {
          const stepNumber = index + 1;
          const isCurrent = stepNumber === currentStep;
          const isComplete = stepNumber < currentStep;
          const className = [
            "flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 py-2 sm:gap-2 sm:px-3",
            isCurrent
              ? "bg-stone-800 font-bold text-white"
              : isComplete
                ? "bg-stone-200 font-medium text-stone-800"
                : "bg-stone-100 text-stone-500",
          ].join(" ");
          const content = (
            <>
              <span aria-hidden="true" className="shrink-0 font-semibold">{stepNumber}</span>
              <span className="truncate">{step.label}</span>
            </>
          );

          return (
            <li key={step.href} className="min-w-0">
              {isCurrent ? (
                <span aria-current="step" className={className}>{content}</span>
              ) : isComplete && allowCompletedNavigation ? (
                <Link href={step.href} className={className}>{content}</Link>
              ) : isComplete ? (
                <span aria-disabled="true" className={`${className} cursor-not-allowed opacity-70`}>{content}</span>
              ) : (
                <span className={className}>{content}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
