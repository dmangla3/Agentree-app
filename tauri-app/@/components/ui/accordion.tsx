"use client";

import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { motion } from "framer-motion";

import { cn } from "../../../src/lib/utils";
import { useReducedMotion, DURATION, EASING } from "../../../src/lib/animation";

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item
    ref={ref}
    className={cn("border-b", className)}
    {...props}
  />
));
AccordionItem.displayName = "AccordionItem";

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex flex-1 items-center justify-between py-4 font-medium transition-all hover:underline [&[data-state=open]>svg]:rotate-180",
        className
      )}
      {...props}
    >
      {children}
      <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

/**
 * AccordionContent - Smooth height animation using Framer Motion
 * 
 * Replaces the default CSS height animation with Framer Motion's
 * animate prop for smoother, more performant transitions.
 * Respects reduced motion preferences.
 */
const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const reducedMotion = useReducedMotion();

  return (
    <AccordionPrimitive.Content
      ref={ref}
      className="overflow-hidden text-sm"
      asChild
      {...props}
    >
      <motion.div
        initial={false}
        animate={{
          height: "var(--radix-accordion-content-height)",
          opacity: 1,
        }}
        exit={{
          height: 0,
          opacity: reducedMotion ? 0 : 1,
        }}
        transition={
          reducedMotion
            ? { duration: DURATION.instant }
            : {
                height: {
                  duration: DURATION.normal,
                  ease: EASING.default,
                },
                opacity: {
                  duration: DURATION.fast,
                  ease: EASING.default,
                },
              }
        }
        style={{
          // Use will-change for GPU acceleration
          willChange: reducedMotion ? undefined : "height, opacity",
        }}
      >
        <div className={cn("pb-4 pt-0", className)}>{children}</div>
      </motion.div>
    </AccordionPrimitive.Content>
  );
});

AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
