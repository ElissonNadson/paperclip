import { Globe } from "lucide-react";
import { useTranslation, changeLanguage, getCurrentLocale } from "@/i18n";
import { cn } from "@/lib/utils";

interface LanguageToggleProps {
  className?: string;
  variant?: "icon" | "compact-menu-action";
  onAfterToggle?: () => void;
}

export function LanguageToggle({ className, variant = "compact-menu-action", onAfterToggle }: LanguageToggleProps) {
  const { t } = useTranslation();
  const current = getCurrentLocale();
  const isPt = current.startsWith("pt");
  const nextLocale = isPt ? "en" : "pt-BR";
  const label = isPt ? "Idioma: Português (BR)" : "Language: English";

  function handleClick() {
    changeLanguage(nextLocale);
    onAfterToggle?.();
  }

  if (variant === "compact-menu-action") {
    return (
      <button
        type="button"
        className={cn(
          "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-accent",
          className,
        )}
        onClick={handleClick}
        aria-label={label}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <Globe className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      <Globe className="size-4" />
    </button>
  );
}
