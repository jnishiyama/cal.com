import type { User } from "@prisma/client";
import { Prisma } from "@prisma/client";

import type { LocationObject } from "@calcom/app-store/locations";
import { privacyFilteredLocations } from "@calcom/app-store/locations";
import { getAppFromSlug } from "@calcom/app-store/utils";
import { getBookingFieldsWithSystemFields } from "@calcom/features/bookings/lib/getBookingFields";
import { isRecurringEvent, parseRecurringEvent } from "@calcom/lib";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { getDefaultEvent } from "@calcom/lib/defaultEvents";
import { markdownToSafeHTML } from "@calcom/lib/markdownToSafeHTML";
import type { PrismaClient } from "@calcom/prisma/client";
import type { BookerLayoutSettings } from "@calcom/prisma/zod-utils";
import {
  bookerLayoutOptions,
  EventTypeMetaDataSchema,
  customInputSchema,
  userMetadata as userMetadataSchema,
  bookerLayouts as bookerLayoutsSchema,
  BookerLayouts,
} from "@calcom/prisma/zod-utils";

const publicEventSelect = Prisma.validator<Prisma.EventTypeSelect>()({
  id: true,
  title: true,
  description: true,
  eventName: true,
  slug: true,
  schedulingType: true,
  length: true,
  locations: true,
  customInputs: true,
  disableGuests: true,
  metadata: true,
  requiresConfirmation: true,
  recurringEvent: true,
  price: true,
  currency: true,
  seatsPerTimeSlot: true,
  bookingFields: true,
  team: true,
  successRedirectUrl: true,
  workflows: {
    include: {
      workflow: {
        include: {
          steps: true,
        },
      },
    },
  },
  hosts: {
    select: {
      user: {
        select: {
          username: true,
          name: true,
          weekStart: true,
          brandColor: true,
          darkBrandColor: true,
          theme: true,
          metadata: true,
        },
      },
    },
  },
  owner: {
    select: {
      weekStart: true,
      username: true,
      name: true,
      theme: true,
      metadata: true,
      brandColor: true,
      darkBrandColor: true,
    },
  },
  hidden: true,
});

export const getPublicEvent = async (
  username: string,
  eventSlug: string,
  isTeamEvent: boolean | undefined,
  prisma: PrismaClient
) => {
  const usernameList = username.split("+");

  // In case of dynamic group event, we fetch user's data and use the default event.
  if (usernameList.length > 1) {
    const users = await prisma.user.findMany({
      where: {
        username: {
          in: usernameList,
        },
      },
      select: {
        username: true,
        name: true,
        weekStart: true,
        metadata: true,
        brandColor: true,
        darkBrandColor: true,
        theme: true,
      },
    });

    const defaultEvent = getDefaultEvent(eventSlug);
    let locations = defaultEvent.locations ? (defaultEvent.locations as LocationObject[]) : [];

    // Get the prefered location type from the first user
    const firstUsersMetadata = userMetadataSchema.parse(users[0].metadata || {});
    const preferedLocationType = firstUsersMetadata?.defaultConferencingApp;

    if (preferedLocationType?.appSlug) {
      const foundApp = getAppFromSlug(preferedLocationType.appSlug);
      const appType = foundApp?.appData?.location?.type;
      if (appType) {
        // Replace the location with the prefered location type
        // This will still be default to daily if the app is not found
        locations = [{ type: appType, link: preferedLocationType.appLink }] as LocationObject[];
      }
    }

    const defaultEventBookerLayouts = {
      enabledLayouts: [...bookerLayoutOptions],
      defaultLayout: BookerLayouts.MONTH_VIEW,
    } as BookerLayoutSettings;

    return {
      ...defaultEvent,
      bookingFields: getBookingFieldsWithSystemFields(defaultEvent),
      // Clears meta data since we don't want to send this in the public api.
      users: users.map((user) => ({ ...user, metadata: undefined })),
      locations: privacyFilteredLocations(locations),
      profile: {
        username: users[0].username,
        name: users[0].name,
        weekStart: users[0].weekStart,
        image: `${WEBAPP_URL}/${users[0].username}/avatar.png`,
        brandColor: users[0].brandColor,
        darkBrandColor: users[0].darkBrandColor,
        theme: null,
        bookerLayouts: bookerLayoutsSchema.parse(
          firstUsersMetadata?.defaultBookerLayouts || defaultEventBookerLayouts
        ),
      },
    };
  }

  const usersOrTeamQuery = isTeamEvent
    ? {
        team: {
          slug: username,
        },
      }
    : {
        users: {
          some: {
            username,
          },
        },
        team: null,
      };

  // In case it's not a group event, it's either a single user or a team, and we query that data.
  const event = await prisma.eventType.findFirst({
    where: {
      slug: eventSlug,
      ...usersOrTeamQuery,
    },
    select: publicEventSelect,
  });

  if (!event) return null;

  const eventMetaData = EventTypeMetaDataSchema.parse(event.metadata || {});

  const users = getUsersFromEvent(event) || (await getOwnerFromUsersArray(prisma, event.id));
  if (users === null) {
    throw new Error("Event has no owner");
  }

  return {
    ...event,
    bookerLayouts: bookerLayoutsSchema.parse(eventMetaData?.bookerLayouts || null),
    description: markdownToSafeHTML(event.description),
    metadata: eventMetaData,
    customInputs: customInputSchema.array().parse(event.customInputs || []),
    locations: privacyFilteredLocations((event.locations || []) as LocationObject[]),
    bookingFields: getBookingFieldsWithSystemFields(event),
    recurringEvent: isRecurringEvent(event.recurringEvent) ? parseRecurringEvent(event.recurringEvent) : null,
    // Sets user data on profile object for easier access
    profile: getProfileFromEvent(event),
    users,
  };
};

const eventData = Prisma.validator<Prisma.EventTypeArgs>()({
  select: publicEventSelect,
});

type Event = Prisma.EventTypeGetPayload<typeof eventData>;

function getProfileFromEvent(event: Event) {
  const { team, hosts, owner } = event;
  const profile = team || hosts?.[0]?.user || owner;
  if (!profile) throw new Error("Event has no owner");

  const username = "username" in profile ? profile.username : team?.slug;
  if (!username) {
    if (event.slug === "test") {
      // @TODO: This is a temporary debug statement that should be removed asap.
      throw new Error(
        "Ciaran event error" +
          JSON.stringify(team) +
          " -- " +
          JSON.stringify(hosts) +
          " -- " +
          JSON.stringify(owner)
      );
    }
    throw new Error("Event has no username/team slug");
  }
  const weekStart = hosts?.[0]?.user?.weekStart || owner?.weekStart || "Monday";
  const basePath = team ? `/team/${username}` : `/${username}`;
  const eventMetaData = EventTypeMetaDataSchema.parse(event.metadata || {});
  const userMetaData = userMetadataSchema.parse(profile.metadata || {});

  return {
    username,
    name: profile.name,
    weekStart,
    image: team ? undefined : `${WEBAPP_URL}${basePath}/avatar.png`,
    logo: !team ? undefined : team.logo,
    brandColor: profile.brandColor,
    darkBrandColor: profile.darkBrandColor,
    theme: profile.theme,
    bookerLayouts: bookerLayoutsSchema.parse(
      eventMetaData?.bookerLayouts ||
        (userMetaData && "defaultBookerLayouts" in userMetaData ? userMetaData.defaultBookerLayouts : null)
    ),
  };
}

function getUsersFromEvent(event: Event) {
  const { team, hosts, owner } = event;
  if (team) {
    return (hosts || []).map(mapHostsToUsers);
  }
  if (!owner) {
    return null;
  }
  const { username, name, weekStart } = owner;
  return [{ username, name, weekStart }];
}

async function getOwnerFromUsersArray(prisma: PrismaClient, eventTypeId: number) {
  const { users } = await prisma.eventType.findUniqueOrThrow({
    where: { id: eventTypeId },
    select: { users: { select: { username: true, name: true, weekStart: true } } },
  });
  if (!users.length) return null;
  return [users[0]];
}

function mapHostsToUsers(host: { user: Pick<User, "username" | "name" | "weekStart"> }) {
  return {
    username: host.user.username,
    name: host.user.name,
    weekStart: host.user.weekStart,
  };
}
