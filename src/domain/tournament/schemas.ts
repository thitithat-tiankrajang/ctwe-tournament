import { z } from "zod";

export const createCardSchema = z.object({
  name: z.string().trim().min(2, "กรุณาระบุชื่อการแข่งขัน"),
  division: z.string().trim().min(2, "กรุณาระบุรุ่นการแข่งขัน"),
  numberOfGames: z.coerce.number().int().min(2, "อย่างน้อย 2 เกม").max(12, "สูงสุด 12 เกม"),
});

export const playerSchema = z.object({
  firstName: z.string().trim().min(1, "กรุณาระบุชื่อ"),
  lastName: z.string().trim().min(1, "กรุณาระบุนามสกุล"),
  school: z.string().trim().min(1, "กรุณาระบุโรงเรียน"),
});

export type CreateCardForm = z.infer<typeof createCardSchema>;
export type PlayerForm = z.infer<typeof playerSchema>;
