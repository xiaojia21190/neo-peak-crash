/**
 * Linux DO Logo 组件
 */

import React from "react";

interface LinuxDoLogoProps {
  className?: string;
}

export function LinuxDoLogo({ className = "h-4 w-4" }: LinuxDoLogoProps) {
  return (
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <clipPath id="linuxdo-clip">
          <circle cx="60" cy="60" r="47" />
        </clipPath>
      </defs>
      <circle fill="#f0f0f0" cx="60" cy="60" r="50" />
      <rect fill="#1c1c1e" clipPath="url(#linuxdo-clip)" x="10" y="10" width="100" height="30" />
      <rect fill="#f0f0f0" clipPath="url(#linuxdo-clip)" x="10" y="40" width="100" height="40" />
      <rect fill="#ffb003" clipPath="url(#linuxdo-clip)" x="10" y="80" width="100" height="30" />
    </svg>
  );
}
