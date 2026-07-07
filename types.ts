export interface Room {
  id: string;
  name: string;
  capacity: number;
  amenities: string[];
  imageUrl: string;
  floor: string;
}

export interface Booking {
  id: string;
  roomId: string;
  organizerName: string;
  meetingTitle: string;
  startTime: string; // ISO String
  endTime: string; // ISO String
  color: string; // For UI visualization
  recurrenceGroupId?: string; // Links recurring bookings together
}

export interface RecurrencePattern {
  enabled: boolean;
  type: 'daily' | 'weekly' | 'monthly' | 'annual';
  interval: number; // Every X days/weeks/months/years
  weekDays: number[]; // 0=Sunday, 1=Monday, ... 6=Saturday (for weekly)
  endType: 'date' | 'occurrences' | 'never';
  endDate?: string; // ISO date
  occurrences?: number;
}

export interface Invite {
  id: string;
  bookingId: string;
  inviterId: string;
  inviterName: string;
  inviteeId: string;
  inviteeName: string;
  inviteeEmail?: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  roomName: string;
  meetingTitle: string;
  startTime: string;
  endTime: string;
  createdAt: string;
}

export enum RoomStatus {
  AVAILABLE = 'AVAILABLE',
  OCCUPIED = 'OCCUPIED',
  BOOKED_SOON = 'BOOKED_SOON'
}

export interface RoomWithStatus extends Room {
  status: RoomStatus;
  nextBooking?: Booking | null;
  currentBooking?: Booking | null;
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
}