import { Avatar, Style } from "@dicebear/core";
import notionistsDefinition from "@dicebear/styles/notionists.json" with { type: "json" };

const employeeAvatarStyle = new Style(notionistsDefinition);

export function generateEmployeeAvatarDataUri(seed: string): string {
  return new Avatar(employeeAvatarStyle, {
    seed,
    size: 128,
    backgroundColor: ["#dbeafe", "#dcfce7", "#ede9fe", "#fce7f3", "#fef3c7"],
    scale: 1.12,
  }).toDataUri();
}
