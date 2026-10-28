"use client"

import { useId } from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { Info } from "lucide-react"

import { Button } from "@/components/ui/button"
import { AUTO_BENCHMARKCARDS_DATASET_URL } from "@/lib/benchmark-metadata-utils"

export function AutoBenchmarkCardsInfo({ sourcePath }: { sourcePath?: string | null }) {
  const descriptionId = useId()
  const segments = sourcePath?.split("/")
  const correctionsUrl = segments?.every((segment) => segment && segment !== "." && segment !== "..")
    ? `${AUTO_BENCHMARKCARDS_DATASET_URL}/blob/main/${segments.map(encodeURIComponent).join("/")}`
    : AUTO_BENCHMARKCARDS_DATASET_URL

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 rounded-full text-muted-foreground/70 hover:text-foreground"
          aria-label="About Auto-BenchmarkCards metadata"
          onClick={(event) => event.stopPropagation()}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          aria-label="Auto-BenchmarkCards metadata"
          aria-describedby={descriptionId}
          className="z-50 w-max max-w-[calc(100vw-2rem)] rounded-md border border-border/70 bg-popover px-3 py-2 text-xs font-normal normal-case leading-5 tracking-normal text-popover-foreground shadow-lg"
          onClick={(event) => event.stopPropagation()}
        >
          <p id={descriptionId}>
            This metadata is generated via Auto-BenchmarkCards.
            <br />
            Spotted an error?{" "}
            <a
              href={correctionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4 hover:text-primary/80"
            >
              Suggest corrections
            </a>.
          </p>
          <PopoverPrimitive.Arrow className="fill-popover" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
