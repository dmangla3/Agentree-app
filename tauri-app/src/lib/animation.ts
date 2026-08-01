/**
 * Animation Design Tokens & Configuration
 * 
 * Centralized animation constants for consistent timing and easing
 * across the Agentree application.
 */

import { useEffect, useState } from 'react';
import type { Transition, Variants } from 'framer-motion';

// ============================================================================
// DURATION TOKENS (in seconds)
// ============================================================================

export const DURATION = {
  /** Instant feedback - hover states, color changes */
  instant: 0.1,
  /** Quick feedback - button presses, toggles */
  fast: 0.15,
  /** Standard transitions - most UI animations */
  normal: 0.2,
  /** Emphasis animations - toasts, modals */
  slow: 0.3,
  /** Complex sequences - page transitions */
  complex: 0.4,
  /** Background effects - ambient animations */
  ambient: 0.5,
} as const;

// ============================================================================
// EASING TOKENS
// ============================================================================

export const EASING = {
  /** Standard ease for most animations */
  default: [0.4, 0, 0.2, 1] as const,
  /** Entering elements - slight anticipation */
  enter: [0, 0, 0.2, 1] as const,
  /** Exiting elements - quick fade */
  exit: [0.4, 0, 1, 1] as const,
  /** Bouncy, playful feel */
  bounce: [0.68, -0.55, 0.265, 1.55] as const,
  /** Smooth deceleration */
  smooth: [0.25, 0.1, 0.25, 1] as const,
  /** Custom cubic bezier for page animations */
  easeOutCubic: [0.33, 1, 0.68, 1] as const,
} as const;

// ============================================================================
// SPRING CONFIGURATION
// ============================================================================

export const SPRING = {
  /** Default spring - balanced feel */
  default: {
    type: 'spring' as const,
    stiffness: 300,
    damping: 25,
  },
  /** Snappy spring - quick response */
  snappy: {
    type: 'spring' as const,
    stiffness: 400,
    damping: 30,
  },
  /** Gentle spring - smooth, slow settle */
  gentle: {
    type: 'spring' as const,
    stiffness: 200,
    damping: 20,
  },
  /** Bouncy spring - playful feel */
  bouncy: {
    type: 'spring' as const,
    stiffness: 300,
    damping: 15,
  },
  /** Stiff spring - minimal bounce */
  stiff: {
    type: 'spring' as const,
    stiffness: 500,
    damping: 35,
  },
} as const;

// ============================================================================
// STAGGER CONFIGURATION
// ============================================================================

export const STAGGER = {
  /** Fast stagger for dense lists */
  fast: 0.03,
  /** Normal stagger for standard lists */
  normal: 0.05,
  /** Slow stagger for emphasis */
  slow: 0.1,
  /** Very slow for dramatic reveals */
  dramatic: 0.15,
} as const;

// ============================================================================
// PRESET TRANSITIONS
// ============================================================================

export const transitions: Record<string, Transition> = {
  /** Default transition for most animations */
  default: {
    duration: DURATION.normal,
    ease: EASING.default,
  },
  /** Fast transition for hover states */
  fast: {
    duration: DURATION.fast,
    ease: EASING.default,
  },
  /** Slow transition for modals/toasts */
  slow: {
    duration: DURATION.slow,
    ease: EASING.enter,
  },
  /** Spring transition for interactive elements */
  spring: SPRING.default,
  /** Snappy spring for quick feedback */
  snappy: SPRING.snappy,
  /** Gentle spring for large elements */
  gentle: SPRING.gentle,
  /** Opacity-only transition for reduced motion */
  opacity: {
    duration: DURATION.fast,
  },
} as const;

// ============================================================================
// PRESET VARIANTS
// ============================================================================

export const variants: Record<string, Variants> = {
  /** Fade in from below */
  fadeInUp: {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: DURATION.normal,
        ease: EASING.easeOutCubic,
      },
    },
  },
  /** Fade in from above */
  fadeInDown: {
    hidden: { opacity: 0, y: -20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: DURATION.normal,
        ease: EASING.easeOutCubic,
      },
    },
  },
  /** Scale up with fade */
  scaleUp: {
    hidden: { opacity: 0, scale: 0.95 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: {
        duration: DURATION.normal,
        ease: EASING.easeOutCubic,
      },
    },
  },
  /** Scale down with fade */
  scaleDown: {
    hidden: { opacity: 0, scale: 1.05 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: {
        duration: DURATION.normal,
        ease: EASING.easeOutCubic,
      },
    },
  },
  /** Simple fade */
  fade: {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        duration: DURATION.fast,
      },
    },
  },
  /** Slide in from right */
  slideInRight: {
    hidden: { opacity: 0, x: 100 },
    visible: {
      opacity: 1,
      x: 0,
      transition: {
        duration: DURATION.slow,
        ease: EASING.enter,
      },
    },
    exit: {
      opacity: 0,
      x: 100,
      transition: {
        duration: DURATION.fast,
        ease: EASING.exit,
      },
    },
  },
  /** Stagger container for lists */
  staggerContainer: {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: STAGGER.normal,
        delayChildren: 0,
      },
    },
  },
  /** Stagger item for list children */
  staggerItem: {
    hidden: { opacity: 0, y: 10 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: DURATION.normal,
        ease: EASING.easeOutCubic,
      },
    },
  },
} as const;

// ============================================================================
// REDUCED MOTION HOOK
// ============================================================================

/**
 * Hook to detect user's motion preference
 * Returns true if user prefers reduced motion
 */
export function useReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return prefersReducedMotion;
}

// ============================================================================
// MOTION CONFIGURATION HELPERS
// ============================================================================

/**
 * Get transition configuration respecting reduced motion preference
 */
export function getTransition(
  transition: Transition,
  reducedMotion: boolean
): Transition {
  if (!reducedMotion) return transition;

  // For reduced motion, use instant transitions for most properties
  // Only animate opacity for accessibility
  return {
    duration: DURATION.instant,
    opacity: { duration: DURATION.fast },
  };
}

/**
 * Get spring configuration respecting reduced motion preference
 */
export function getSpring(
  springConfig: typeof SPRING.default,
  reducedMotion: boolean
): Transition {
  if (!reducedMotion) return springConfig;

  // For reduced motion, convert springs to simple opacity transitions
  return {
    duration: DURATION.fast,
    ease: EASING.default,
  };
}

/**
 * Get variants respecting reduced motion preference
 */
export function getVariants(
  variant: Variants,
  reducedMotion: boolean
): Variants {
  if (!reducedMotion) return variant;

  // For reduced motion, simplify to opacity-only animations
  const reducedVariants: Variants = {};

  for (const [key, value] of Object.entries(variant)) {
    if (typeof value === 'object' && value !== null) {
      reducedVariants[key] = {
        opacity: (value as { opacity?: number }).opacity ?? (key === 'hidden' ? 0 : 1),
        transition: {
          duration: DURATION.fast,
        },
      };
    } else {
      reducedVariants[key] = value;
    }
  }

  return reducedVariants;
}

// ============================================================================
// CSS CUSTOM PROPERTIES (for non-React animations)
// ============================================================================

export const CSS_VARIABLES = {
  '--animation-duration-instant': `${DURATION.instant}s`,
  '--animation-duration-fast': `${DURATION.fast}s`,
  '--animation-duration-normal': `${DURATION.normal}s`,
  '--animation-duration-slow': `${DURATION.slow}s`,
  '--animation-duration-complex': `${DURATION.complex}s`,
  '--animation-easing-default': 'cubic-bezier(0.4, 0, 0.2, 1)',
  '--animation-easing-enter': 'cubic-bezier(0, 0, 0.2, 1)',
  '--animation-easing-exit': 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

// ============================================================================
// TAILWIND CONFIGURATION EXTENSION
// ============================================================================

/**
 * Extend your tailwind.config.js with these animation values:
 * 
 * theme: {
 *   extend: {
 *     transitionDuration: {
 *       'instant': '100ms',
 *       'fast': '150ms',
 *       'normal': '200ms',
 *       'slow': '300ms',
 *       'complex': '400ms',
 *     },
 *     transitionTimingFunction: {
 *       'enter': 'cubic-bezier(0, 0, 0.2, 1)',
 *       'exit': 'cubic-bezier(0.4, 0, 1, 1)',
 *       'bounce': 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
 *     },
 *   },
 * }
 */
