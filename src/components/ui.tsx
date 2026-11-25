import { useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../utils/cn";
import { copyText } from "../lib/util";

export type Tone =
  | "zinc"
  | "amber"
  | "emerald"
  | "rose"
  | "sky"
  | "violet"
  | "orange"
  | "white";

const toneCls: Record<Tone, string> = {
  zinc: "bg-zinc-800 text-zinc-300 border-zinc-700",
  amber: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  emerald: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  rose: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  sky: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  violet: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  orange: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  white: "bg-white/10 text-white border-white/25",
};

export function Badge({
  tone = "zinc",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap",
        toneCls[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-zinc-800 bg-zinc-900/60 backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Btn({
  className,
  variant = "default",
  size = "md",
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger" | "success" | "amber";
  size?: "sm" | "md";
}) {
  const v = {
    default: "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border-zinc-700",
    primary: "bg-white hover:bg-zinc-200 text-black border-white",
    ghost: "bg-transparent hover:bg-zinc-800 text-zinc-300 border-transparent",
    danger: "bg-rose-600/90 hover:bg-rose-500 text-white border-rose-500",
    success: "bg-emerald-500 hover:bg-emerald-400 text-black border-emerald-400",
    amber: "bg-amber-400 hover:bg-amber-300 text-black border-amber-300",
  }[variant];
  return (
    <button
      {...p}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition disabled:opacity-40 disabled:cursor-not-allowed",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        v,
        className,
      )}
    />
  );
}

export function CopyBtn({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/80 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
    >
      {done ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      {done ? "Copied" : label}
    </button>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  accent = "white",
  size = "md",
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (t: T) => void;
  accent?: "white" | "amber" | "emerald";
  size?: "sm" | "md";
}) {
  const act = {
    white: "bg-white text-black",
    amber: "bg-amber-400 text-black",
    emerald: "bg-emerald-400 text-black",
  }[accent];
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "rounded-lg font-medium transition",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm",
            value === t.id ? act : "text-zinc-400 hover:text-white hover:bg-zinc-800",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  sub,
}: {
  eyebrow?: string;
  title: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="mb-6">
      {eyebrow && (
        <div className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-amber-400">
          {eyebrow}
        </div>
      )}
      <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h2>
      {sub && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">{sub}</p>}
    </div>
  );
}

export function Code({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("relative rounded-lg border border-zinc-800 bg-black/60", className)}>
      <div className="absolute right-2 top-2">
        <CopyBtn text={children} />
      </div>
      <pre className="overflow-x-auto p-3 pr-20 text-[12px] leading-relaxed text-zinc-300">
        <code>{children}</code>
      </pre>
    </div>
  );
}
