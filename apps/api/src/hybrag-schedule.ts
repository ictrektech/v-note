import { z } from "zod";

export const defaultHybragSchedule = { mode: "interval" as const, intervalMinutes: 15, timeZone: "UTC", nightStart: 0, nightEnd: 6 };
export const hybragScheduleSchema = z.object({
  mode: z.enum(["manual", "interval", "night"]),
  intervalMinutes: z.number().int().min(15).max(1440),
  timeZone: z.string().min(1).max(128).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }),
  nightStart: z.number().int().min(0).max(23),
  nightEnd: z.number().int().min(0).max(23),
}).refine((value) => value.nightStart !== value.nightEnd);
