import { handleRoomCollectionRoutes } from "./rooms/collection-routes.js";
import { handleRoomMemberRoutes } from "./rooms/member-routes.js";
import { handleRoomMessageRoutes } from "./rooms/message-routes.js";
import type { RoomsRouteInput } from "./rooms/route-context.js";

export async function handleRoomsRoute(input: RoomsRouteInput): Promise<boolean> {
  return (
    (await handleRoomCollectionRoutes(input)) ||
    (await handleRoomMemberRoutes(input)) ||
    (await handleRoomMessageRoutes(input))
  );
}
