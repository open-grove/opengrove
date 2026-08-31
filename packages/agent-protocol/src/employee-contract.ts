import { z } from "zod";

export const employeeVisibilitySchema = z.enum(["private", "public"]);
export type EmployeeVisibility = z.infer<typeof employeeVisibilitySchema>;

export interface EmployeeIOContract {
  inputSpec?: string;
  outputSpec?: string;
}

export interface EmployeePublicProfile extends EmployeeIOContract {
  publicDescription?: string;
  publicSkills?: string[];
  visibility?: EmployeeVisibility;
}

export const employeeIOContractSchema = z.object({
  inputSpec: z.string().optional(),
  outputSpec: z.string().optional(),
});

export const employeePublicProfileSchema = employeeIOContractSchema.extend({
  publicDescription: z.string().optional(),
  publicSkills: z.array(z.string()).optional(),
  visibility: employeeVisibilitySchema.optional(),
});
