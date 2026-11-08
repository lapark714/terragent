/**
 * The founders' Terragent logo, from their artwork (brand/*.png: tight-cropped alpha masks made from the
 * black-on-white originals). Rendered as a CSS mask filled with currentColor, so it takes any text colour
 * and the globe's continents show the page through, exactly like the paper did in the original.
 */
import type { StaticImageData } from "next/image";
import lockup from "./brand/lockup.png";
import mark from "./brand/mark.png";

function Masked({ img, className, label, style }: { img: StaticImageData; className: string; label?: string; style?: React.CSSProperties }) {
  const url = `url(${img.src})`;
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`inline-block bg-current ${className}`}
      style={{
        aspectRatio: `${img.width} / ${img.height}`,
        maskImage: url,
        WebkitMaskImage: url,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
        ...style,
      }}
    />
  );
}

/** The globe-pin mark alone. Size it by height (e.g. "h-8"). */
export function LogoMark({ className = "h-8", label }: { className?: string; label?: string }) {
  return <Masked img={mark} className={className} label={label} />;
}

/** Mark + "terragent" in the founders' serif. Size it by height (e.g. "h-7"). */
export function LogoLockup({ className = "h-7", label = "Terragent" }: { className?: string; label?: string }) {
  return <Masked img={lockup} className={`text-fg ${className}`} label={label} />;
}

/** Where the pin's tip sits across the mark's width (measured from the artwork), for anchoring it on a map. */
export const MARK_TIP_X = 0.439;
export const markSrc = mark.src;
export const markAspect = mark.width / mark.height;
