import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Room, Booking, RoomStatus, RoomWithStatus, User, RecurrencePattern, Invite } from './types';
import { ROOMS } from './constants/rooms';
import { bookingService } from './services/bookingService';
import { inviteService, sendEmailNotification } from './services/inviteService';
import { authService } from './services/auth';
import BookingForm from './components/BookingForm';
import WeeklyCalendar from './components/WeeklyCalendar';
import IntroScreen from './components/IntroScreen';
import AuthScreen from './components/AuthScreen';
import InvitePopup from './components/InvitePopup';
import { LogOut, User as UserIcon, Bell, X, Check, Pencil, Users } from 'lucide-react';
import { parseLisbonDateTime } from './utils/lisbon';
import { buildBookingEmail, BookingEmailAction } from './utils/emailTemplates';

/** Envia o e-mail HTML estiloso a todos os utilizadores registados. */
async function broadcastBookingEmail(
  action: BookingEmailAction,
  organizerName: string,
  meetingTitle: string,
  roomName: string,
  startTime: string,
  endTime: string,
  invitees: { name: string; email?: string }[] = [],
) {
  try {
    const allUsers = await inviteService.getRegisteredUsers();
    const { subject, text, html } = buildBookingEmail({
      action, organizerName, meetingTitle, roomName, startTime, endTime, invitees,
    });
    for (const u of allUsers) {
      if (!u.email) continue;
      await sendEmailNotification({
        notification: true,
        to: u.email,
        subject,
        message: text,
        html,
      });
    }
  } catch (e) {
    console.warn('Falha ao notificar usuários por email', e);
  }
}

interface Notification {
  id: string;
  message: string;
  timestamp: Date;
  read: boolean;
  type: 'booking' | 'invite';
  inviteId?: string;
  inviteStatus?: 'pending' | 'accepted' | 'declined' | 'cancelled';
}

type ViewState = 'INTRO' | 'AUTH' | 'APP';

const App: React.FC = () => {
  // Navigation & User State
  const [view, setView] = useState<ViewState>('INTRO');
  const [user, setUser] = useState<User | null>(null);

  // App Logic State
  const [rooms, setRooms] = useState<Room[]>(ROOMS);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [bookingRoom, setBookingRoom] = useState<Room | null>(null);
  const [isBookingModalOpen, setIsBookingModalOpen] = useState(false);
  const [activeRoomId, setActiveRoomId] = useState<string>(ROOMS[0].id);
  const [currentTime, setCurrentTime] = useState(new Date());

  // State for pre-filling the form from calendar interaction
  const [prefilledBooking, setPrefilledBooking] = useState<{start: Date, end: Date} | null>(null);

  // Edit booking state
  const [editingBooking, setEditingBooking] = useState<Booking | null>(null);

  // Notifications state
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const prevBookingsRef = useRef<Booking[]>([]);

  // Track booking IDs being optimistically deleted to prevent realtime/poll from re-adding them
  const pendingDeleteIds = useRef<Set<string>>(new Set());

  // Edit name state
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');

  // Invite state
  const [invites, setInvites] = useState<Invite[]>([]);
  const [sentInvites, setSentInvites] = useState<Invite[]>([]);
  const [registeredUsers, setRegisteredUsers] = useState<User[]>([]);
  const prevSentInvitesRef = useRef<Map<string, string>>(new Map()); // inviteId -> status

  // Popup state for new invite notifications
  const [popupInvites, setPopupInvites] = useState<Invite[]>([]);
  const shownPopupIds = useRef<Set<string>>(new Set());

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'warning' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const showToast = (message: string, type: 'success' | 'error' | 'warning' = 'error') => {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };

  // --- Persist read notification IDs in localStorage ---
  const READ_NOTIFS_KEY = 'readNotificationIds';
  const getReadNotifIds = (): Set<string> => {
    try {
      const raw = localStorage.getItem(READ_NOTIFS_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  };
  const markNotifIdsAsRead = (ids: string[]) => {
    const current = getReadNotifIds();
    for (const id of ids) current.add(id);
    // Keep max 200 entries to avoid bloat
    const arr = [...current].slice(-200);
    localStorage.setItem(READ_NOTIFS_KEY, JSON.stringify(arr));
  };
  const isNotifRead = (id: string): boolean => getReadNotifIds().has(id);

  // Close notifications on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Check session on mount and subscribe to auth changes
  useEffect(() => {
    const checkSession = async () => {
      const sessionUser = await authService.getSession();
      if (sessionUser) {
        setUser(sessionUser);
        setView('APP');
        // Upsert profile on session restore
        inviteService.upsertProfile(sessionUser);
      }
    };
    checkSession();

    // Subscribe to auth state changes
    const unsubscribe = authService.onAuthStateChange((authUser) => {
      setUser(authUser);
      if (authUser) {
        setView('APP');
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Load bookings with realtime subscription (no polling flicker)
  useEffect(() => {
    let prevBookingsJson = '';

    const handleBookingsUpdate = (data: Booking[]) => {
      // Filter out bookings that are being optimistically deleted
      const filtered = pendingDeleteIds.current.size > 0
        ? data.filter(b => !pendingDeleteIds.current.has(b.id))
        : data;

      // Quick check: if data is identical, skip all updates
      const json = JSON.stringify(filtered.map(b => b.id));
      if (json === prevBookingsJson) return;
      prevBookingsJson = json;

      // Generate notifications for new bookings
      if (prevBookingsRef.current.length > 0) {
        const prevIds = new Set(prevBookingsRef.current.map(b => b.id));
        const newBookings = filtered.filter(b => !prevIds.has(b.id));
        
        if (newBookings.length > 0) {
          const newNotifs: Notification[] = newBookings.map(b => {
            const roomName = ROOMS.find(r => r.id === b.roomId)?.name || 'Sala';
            const date = new Date(b.startTime).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Lisbon' });
            const time = new Date(b.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' });
            return {
              id: `notif-${b.id}-${Date.now()}`,
              message: `${b.organizerName} reservou ${roomName} em ${date} às ${time} - ${b.meetingTitle}`,
              timestamp: new Date(),
              read: false,
              type: 'booking' as const,
            };
          });
          setNotifications(prev => [...newNotifs, ...prev].slice(0, 50));
        }
      }
      
      prevBookingsRef.current = filtered;
      setBookings(filtered);
    };

    // Initial load
    const loadBookings = async () => {
      try {
        const data = await bookingService.getAll();
        handleBookingsUpdate(data);
      } catch (error) {
        console.error('Erro ao carregar reservas:', error);
      }
    };
    loadBookings();

    // Realtime subscription — instant updates without polling
    const unsubscribe = bookingService.subscribe((data) => {
      handleBookingsUpdate(data);
    });

    // Fallback: infrequent poll (30s) in case realtime misses something
    const fallbackInterval = setInterval(loadBookings, 30000);

    return () => {
      unsubscribe();
      clearInterval(fallbackInterval);
    };
  }, []);

  // Load invites and registered users — realtime only, no polling
  useEffect(() => {
    if (!user) return;

    // Track which invite IDs we already created notifications for (to avoid duplicates)

    // Merges new invite-based notifications into existing ones,
    // preserving read state for already-existing notifications.
    const mergeInviteNotifications = (myInvites: Invite[]) => {
      setNotifications(prev => {
        // Build a map of existing notifications by ID to preserve read state
        const existingMap = new Map<string, Notification>();
        for (const n of prev) {
          existingMap.set(n.id, n);
        }

        const nonInviteNotifs = prev.filter(n => n.type !== 'invite');
        const freshInviteNotifs: Notification[] = [];

        // Pending invites
        for (const inv of myInvites.filter(i => i.status === 'pending')) {
          const nId = `invite-${inv.id}`;
          const existing = existingMap.get(nId);
          freshInviteNotifs.push({
            id: nId,
            message: `${inv.inviterName} convidou-o para "${inv.meetingTitle}" em ${inv.roomName} no dia ${new Date(inv.startTime).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Lisbon' })} às ${new Date(inv.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' })}`,
            timestamp: new Date(inv.createdAt),
            read: existing ? existing.read : isNotifRead(nId),
            type: 'invite' as const,
            inviteId: inv.id,
            inviteStatus: inv.status,
          });
        }

        // Cancelled invites
        for (const inv of myInvites.filter(i => i.status === 'cancelled')) {
          const nId = `cancel-${inv.id}`;
          const existing = existingMap.get(nId);
          freshInviteNotifs.push({
            id: nId,
            message: `${inv.inviterName} cancelou a reunião "${inv.meetingTitle}" em ${inv.roomName} no dia ${new Date(inv.startTime).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Lisbon' })} às ${new Date(inv.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' })}`,
            timestamp: new Date(inv.createdAt),
            read: existing ? existing.read : isNotifRead(nId),
            type: 'invite' as const,
            inviteStatus: 'cancelled' as const,
          });
        }

        return [...freshInviteNotifs, ...nonInviteNotifs].slice(0, 50);
      });
    };

    // Only update invites state if the data actually changed
    const prevInvitesJsonRef = { current: '' };
    const updateInvites = (myInvites: Invite[]) => {
      const json = JSON.stringify(myInvites.map(i => i.id + i.status));
      if (json === prevInvitesJsonRef.current) return; // no change
      prevInvitesJsonRef.current = json;
      setInvites(myInvites);
      mergeInviteNotifications(myInvites);
    };

    // Only update sent invites state if data changed, and detect response changes
    const checkSentInviteResponses = (currentSentInvites: Invite[]) => {
      const prevMap = prevSentInvitesRef.current;
      const newNotifs: Notification[] = [];

      for (const inv of currentSentInvites) {
        const prevStatus = prevMap.get(inv.id);
        if (prevStatus && prevStatus === 'pending' && inv.status !== 'pending') {
          const nId = `response-${inv.id}-${inv.status}`;
          const statusText = inv.status === 'accepted' ? '✅ aceitou' : '❌ recusou';
          newNotifs.push({
            id: nId,
            message: `${inv.inviteeName} ${statusText} o convite para "${inv.meetingTitle}" em ${inv.roomName} no dia ${new Date(inv.startTime).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Lisbon' })} às ${new Date(inv.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' })}`,
            timestamp: new Date(),
            read: false,
            type: 'booking' as const,
          });
        }
      }

      const newMap = new Map<string, string>();
      for (const inv of currentSentInvites) {
        newMap.set(inv.id, inv.status);
      }
      prevSentInvitesRef.current = newMap;

      if (newNotifs.length > 0) {
        setNotifications(prev => {
          const existingIds = new Set(prev.map(n => n.id));
          const truly = newNotifs.filter(n => !existingIds.has(n.id));
          return truly.length > 0 ? [...truly, ...prev].slice(0, 50) : prev;
        });
      }
    };

    const prevSentJsonRef = { current: '' };
    const updateSentInvites = (mySentInvites: Invite[]) => {
      const json = JSON.stringify(mySentInvites.map(i => i.id + i.status));
      if (json === prevSentJsonRef.current) return;
      prevSentJsonRef.current = json;
      setSentInvites(mySentInvites);
      checkSentInviteResponses(mySentInvites);
    };

    // Fetcher functions that can be called from realtime OR polling
    const refreshInvites = async () => {
      const myInvites = await inviteService.getMyInvites();
      updateInvites(myInvites);
    };
    const refreshSentInvites = async () => {
      const mySentInvites = await inviteService.getMyInvitesAsSender();
      updateSentInvites(mySentInvites);
    };

    // Initial load
    refreshInvites();
    refreshSentInvites();

    // Realtime subscription (all changes, no column filter — works without REPLICA IDENTITY FULL)
    const unsubAll = inviteService.subscribeAll(refreshInvites, refreshSentInvites);

    // Polling backup every 8s — smart comparison prevents flicker
    const pollInterval = setInterval(() => {
      refreshInvites();
      refreshSentInvites();
    }, 8000);

    // Load registered users for invite picker
    const loadUsers = async () => {
      const users = await inviteService.getRegisteredUsers();
      setRegisteredUsers(users);
    };
    loadUsers();
    const usersInterval = setInterval(loadUsers, 30000);

    return () => {
      clearInterval(pollInterval);
      clearInterval(usersInterval);
      unsubAll();
    };
  }, [user]);

  // Auth Handlers
  const handleAuthSuccess = (loggedInUser: User) => {
    setUser(loggedInUser);
    setView('APP');
    // Upsert profile so this user appears in the invite picker for others
    inviteService.upsertProfile(loggedInUser);
  };

  const handleLogout = async () => {
    await authService.logout();
    setUser(null);
    setView('INTRO');
  };

  const processedRooms: RoomWithStatus[] = useMemo(() => {
    return rooms.map(room => {
      const roomBookings = bookings
        .filter(b => b.roomId === room.id)
        .sort((a, b) => parseLisbonDateTime(a.startTime).getTime() - parseLisbonDateTime(b.startTime).getTime());

      const now = currentTime.getTime();
      
      const currentBooking = roomBookings.find(b => {
        const start = parseLisbonDateTime(b.startTime).getTime();
        const end = parseLisbonDateTime(b.endTime).getTime();
        return now >= start && now < end;
      });

      const nextBooking = roomBookings.find(b => {
        return parseLisbonDateTime(b.startTime).getTime() > now;
      });

      let status = RoomStatus.AVAILABLE;
      if (currentBooking) status = RoomStatus.OCCUPIED;
      else if (nextBooking && (parseLisbonDateTime(nextBooking.startTime).getTime() - now) < 30 * 60000) {
        status = RoomStatus.BOOKED_SOON;
      }

      return {
        ...room,
        status,
        currentBooking,
        nextBooking
      };
    });
  }, [rooms, bookings, currentTime]);

  const activeRoom = useMemo(() => 
    processedRooms.find(r => r.id === activeRoomId) || processedRooms[0], 
  [processedRooms, activeRoomId]);

  const activeRoomBookings = useMemo(() => 
    bookings.filter(b => b.roomId === activeRoomId),
  [bookings, activeRoomId]);

  const handleBookRoom = async (room: RoomWithStatus) => {
    // Recarrega reservas do banco antes de abrir o formulário
    const freshData = await bookingService.getAll();
    setBookings(freshData);
    setBookingRoom(room);
    setPrefilledBooking(null);
    setIsBookingModalOpen(true);
  };

  // New handler for selecting range directly on calendar
  const handleCalendarRangeSelect = (start: Date, end: Date) => {
    setBookingRoom(activeRoom);
    setPrefilledBooking({ start, end });
    setIsBookingModalOpen(true);
  };

  const confirmBooking = async (newBookingData: Omit<Booking, 'id'>, recurrence?: RecurrencePattern, invitees?: User[]) => {
    // Validação rápida de recorrência (síncrona)
    let dates: { startTime: string; endTime: string }[] = [];
    let groupId = '';
    if (recurrence?.enabled) {
      dates = generateRecurrenceDates(newBookingData, recurrence);
      if (dates.length === 0) {
        showToast('Nenhuma data válida gerada para a recorrência. Verifique as configurações.', 'warning');
        return;
      }
      groupId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }

    // Fecha o modal de imediato (otimista) e adiciona reserva temporária
    const tempId = `temp-${Date.now()}`;
    const tempBooking: Booking = { id: tempId, ...newBookingData };
    if (!recurrence?.enabled) {
      setBookings(prev => [...prev, tempBooking]);
    }
    setIsBookingModalOpen(false);
    setBookingRoom(null);
    setPrefilledBooking(null);

    // Operação assíncrona em background
    try {
      if (recurrence?.enabled) {
        const bulkBookings = dates.map(d => ({
          ...newBookingData,
          startTime: d.startTime,
          endTime: d.endTime,
          recurrenceGroupId: groupId,
        }));

        const created = await bookingService.createBulk(bulkBookings);
        
        if (created.length > 0) {
          setBookings(prev => [...prev, ...created]);
          if (created.length < dates.length) {
            showToast(`${created.length} de ${dates.length} reservas criadas. Algumas datas tinham conflitos.`, 'warning');
          }
          if (invitees && invitees.length > 0 && user) {
            const roomName = ROOMS.find(r => r.id === newBookingData.roomId)?.name || 'Sala';
            for (const booking of created) {
              try {
                await inviteService.createInvites(
                  booking.id, user, invitees, roomName,
                  booking.meetingTitle, booking.startTime, booking.endTime
                );
              } catch (invErr) {
                console.error('Erro ao enviar convites para reserva', booking.id, invErr);
              }
            }
          }
          // Notificar TODOS os utilizadores sobre cada reserva periódica criada
          if (user) {
            const roomName = ROOMS.find(r => r.id === newBookingData.roomId)?.name || 'Sala';
            const inviteeList = (invitees || []).map(u => ({ name: u.name, email: u.email }));
            for (const booking of created) {
              await broadcastBookingEmail(
                'created',
                booking.organizerName,
                booking.meetingTitle,
                roomName,
                booking.startTime,
                booking.endTime,
                inviteeList,
              );
            }
          }
        } else {
          showToast('Nenhuma reserva periódica foi criada. Todos os horários conflitam.', 'error');
        }
      } else {
        const newBooking = await bookingService.create(newBookingData);
        if (newBooking) {
          // Substitui a reserva temporária pela real
          setBookings(prev => prev.map(b => b.id === tempId ? newBooking : b));
          if (invitees && invitees.length > 0 && user) {
            const roomName = ROOMS.find(r => r.id === newBookingData.roomId)?.name || 'Sala';
            try {
              await inviteService.createInvites(
                newBooking.id, user, invitees, roomName,
                newBooking.meetingTitle, newBooking.startTime, newBooking.endTime
              );
            } catch (invErr) {
              console.error('Erro ao enviar convites:', invErr);
            }
          }
          // Notificar TODOS os utilizadores registados sobre a nova reserva
          const roomName = ROOMS.find(r => r.id === newBookingData.roomId)?.name || 'Sala';
          await broadcastBookingEmail(
            'created',
            newBooking.organizerName,
            newBooking.meetingTitle,
            roomName,
            newBooking.startTime,
            newBooking.endTime,
            (invitees || []).map(u => ({ name: u.name, email: u.email })),
          );
        } else {
          // Remove a reserva temporária — falhou silenciosamente
          setBookings(prev => prev.filter(b => b.id !== tempId));
          showToast('Erro ao criar reserva. Pode haver conflito de horário.', 'error');
        }
      }
    } catch (error) {
      console.error('Erro ao criar reserva:', error);
      // Remove a reserva temporária em caso de erro
      setBookings(prev => prev.filter(b => b.id !== tempId));
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      showToast(msg, 'error');
      const freshData = await bookingService.getAll();
      setBookings(freshData);
    }
  };

  const handleDeleteBooking = async (bookingId: string) => {
    // Get the booking info before deleting (for cancellation notifications)
    const deletedBooking = bookings.find(b => b.id === bookingId);

    // Mark as pending delete so realtime/poll won't re-add it
    pendingDeleteIds.current.add(bookingId);
    
    // Atualiza imediatamente a UI (otimista)
    setBookings(prev => prev.filter(b => b.id !== bookingId));

    // Delete from server immediately (before slow notification operations)
    try {
      const deleted = await bookingService.delete(bookingId);
      if (!deleted) {
        // Delete falhou — recarrega estado real
        pendingDeleteIds.current.delete(bookingId);
        const data = await bookingService.getAll();
        setBookings(data);
        showToast('Erro ao apagar reserva.', 'error');
        return;
      }
    } catch (error) {
      console.error('Erro ao deletar reserva:', error);
      pendingDeleteIds.current.delete(bookingId);
      const data = await bookingService.getAll();
      setBookings(data);
      showToast('Erro ao apagar reserva.', 'error');
      return;
    }

    // Server delete succeeded — remove from pending set
    pendingDeleteIds.current.delete(bookingId);
    
    // Notify invitees about cancellation (non-blocking, after delete succeeded)
    if (deletedBooking && user) {
      try {
        const bookingInvites = await inviteService.getInvitesByBooking(bookingId);
        if (bookingInvites.length > 0) {
          const roomName = ROOMS.find(r => r.id === deletedBooking.roomId)?.name || 'Sala';
          
          for (const inv of bookingInvites) {
            if (inv.inviteeId !== user.id) {
              await inviteService.createCancellationNotice(
                inv.inviteeId, inv.inviteeName, inv.inviteeEmail || '',
                user, roomName,
                deletedBooking.meetingTitle,
                deletedBooking.startTime, deletedBooking.endTime
              );
            }
          }
        }
      } catch (e) {
        console.warn('Erro ao notificar convidados sobre cancelamento:', e);
      }

      // Notify ALL registered users via email about cancellation
      try {
        const roomName = ROOMS.find(r => r.id === deletedBooking.roomId)?.name || 'Sala';
        const bookingInvites = await inviteService.getInvitesByBooking(bookingId).catch(() => []);
        const invitees = bookingInvites.map(inv => ({ name: inv.inviteeName, email: inv.inviteeEmail }));
        await broadcastBookingEmail(
          'cancelled',
          user.name,
          deletedBooking.meetingTitle,
          roomName,
          deletedBooking.startTime,
          deletedBooking.endTime,
          invitees,
        );
      } catch (e) {
        console.warn('Falha ao notificar usuários sobre cancelamento', e);
      }
    }
  };

  // Edit booking handler
  const handleEditBooking = (booking: Booking) => {
    const room = processedRooms.find(r => r.id === booking.roomId);
    if (room) {
      setBookingRoom(room);
      setEditingBooking(booking);
      setPrefilledBooking(null);
      setIsBookingModalOpen(true);
    }
  };

  const handleUpdateBooking = async (bookingId: string, updatedData: Omit<Booking, 'id'>, invitees?: User[]) => {
    // Atualização otimista: fecha modal e atualiza UI de imediato
    const previousBookings = bookings;
    setBookings(prev => prev.map(b => b.id === bookingId ? { id: bookingId, ...updatedData } : b));
    setIsBookingModalOpen(false);
    setBookingRoom(null);
    setEditingBooking(null);

    try {
      const updated = await bookingService.update(bookingId, updatedData);
      if (updated) {
        setBookings(prev => prev.map(b => b.id === bookingId ? updated : b));
        if (invitees && invitees.length > 0 && user) {
          const roomName = ROOMS.find(r => r.id === updatedData.roomId)?.name || 'Sala';
          try {
            await inviteService.createInvites(
              bookingId, user, invitees, roomName,
              updatedData.meetingTitle, updatedData.startTime, updatedData.endTime
            );
          } catch (invErr) {
            console.error('Erro ao enviar convites na edição:', invErr);
          }
        }

        // Notificar TODOS os utilizadores registados por email sobre a alteração
        if (user) {
          const roomName = ROOMS.find(r => r.id === updatedData.roomId)?.name || 'Sala';
          const currentInvites = await inviteService.getInvitesByBooking(bookingId).catch(() => []);
          const inviteeList = [
            ...currentInvites.map(inv => ({ name: inv.inviteeName, email: inv.inviteeEmail })),
            ...(invitees || []).map(u => ({ name: u.name, email: u.email })),
          ];
          // de-duplica por email/nome
          const seen = new Set<string>();
          const uniqueInvitees = inviteeList.filter(i => {
            const k = (i.email || i.name).toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          await broadcastBookingEmail(
            'updated',
            user.name,
            updatedData.meetingTitle,
            roomName,
            updatedData.startTime,
            updatedData.endTime,
            uniqueInvitees,
          );
        }
      }
    } catch (error) {
      console.error('Erro ao atualizar reserva:', error);
      // Reverte para o estado anterior
      setBookings(previousBookings);
      const msg = error instanceof Error ? error.message : 'Erro ao atualizar reserva. Tente novamente.';
      showToast(msg, 'error');
      const freshData = await bookingService.getAll();
      setBookings(freshData);
    }
  };

  // Change name handler
  const handleChangeName = async () => {
    if (!editNameValue.trim() || !user) return;
    try {
      await authService.updateName(editNameValue.trim());
      const updatedUser = { ...user, name: editNameValue.trim() };
      setUser(updatedUser);
      setIsEditingName(false);
      // Update profile in profiles table so others see the new name
      inviteService.upsertProfile(updatedUser);
    } catch (error) {
      console.error('Erro ao atualizar nome:', error);
      showToast('Erro ao atualizar nome.', 'error');
    }
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  // Generate dates for recurring bookings
  const generateRecurrenceDates = (
    baseBooking: Omit<Booking, 'id'>,
    pattern: RecurrencePattern
  ): { startTime: string; endTime: string }[] => {
    const dates: { startTime: string; endTime: string }[] = [];
    const baseStart = new Date(baseBooking.startTime);
    const baseEnd = new Date(baseBooking.endTime);
    const durationMs = baseEnd.getTime() - baseStart.getTime();
    
    // Extract the time portion from the original booking (local format)
    // baseBooking.startTime is like "2026-03-07T10:00:00"
    const timePart = baseBooking.startTime.split('T')[1]; // "10:00:00"
    const endTimePart = baseBooking.endTime.split('T')[1]; // "11:30:00"
    
    const maxOccurrences = pattern.endType === 'never' ? 52 
      : pattern.endType === 'occurrences' ? (pattern.occurrences || 5) 
      : 365;
    
    const endDate = pattern.endType === 'date' && pattern.endDate 
      ? new Date(pattern.endDate + 'T23:59:59') 
      : null;

    // Helper to format date as YYYY-MM-DD
    const fmtDate = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    let count = 0;

    if (pattern.type === 'weekly') {
      const maxDays = maxOccurrences * pattern.interval * 7 + 14;
      const daysCursor = new Date(baseStart);
      daysCursor.setHours(0, 0, 0, 0);
      const startDayOfWeek = daysCursor.getDay();
      
      for (let d = 0; d < maxDays && count < maxOccurrences; d++) {
        const currentDate = new Date(daysCursor);
        currentDate.setDate(daysCursor.getDate() + d);
        const currentDay = currentDate.getDay();
        
        // Calculate which week we're in relative to start
        const daysSinceStart = d;
        const weeksSinceStart = Math.floor(daysSinceStart / 7);

        if (weeksSinceStart % pattern.interval === 0 && pattern.weekDays.includes(currentDay)) {
          if (endDate && currentDate > endDate) break;
          
          const dateStr = fmtDate(currentDate);
          dates.push({
            startTime: `${dateStr}T${timePart}`,
            endTime: `${dateStr}T${endTimePart}`,
          });
          count++;
        }
      }
    } else {
      const cursor = new Date(baseStart);
      
      for (let i = 0; i < maxOccurrences; i++) {
        if (endDate && cursor > endDate) break;
        
        const dateStr = fmtDate(cursor);
        dates.push({
          startTime: `${dateStr}T${timePart}`,
          endTime: `${dateStr}T${endTimePart}`,
        });
        
        // Advance cursor
        if (pattern.type === 'daily') {
          cursor.setDate(cursor.getDate() + pattern.interval);
        } else if (pattern.type === 'monthly') {
          cursor.setMonth(cursor.getMonth() + pattern.interval);
        } else if (pattern.type === 'annual') {
          cursor.setFullYear(cursor.getFullYear() + pattern.interval);
        }
      }
    }

    return dates;
  };

  // Show popup for new pending invites
  useEffect(() => {
    const pendingInvites = invites.filter(i => i.status === 'pending' && !shownPopupIds.current.has(i.id));
    if (pendingInvites.length > 0) {
      for (const inv of pendingInvites) {
        shownPopupIds.current.add(inv.id);
      }
      setPopupInvites(prev => [...prev, ...pendingInvites]);
    }
  }, [invites]);

  const dismissPopupInvite = (inviteId: string) => {
    setPopupInvites(prev => prev.filter(i => i.id !== inviteId));
  };

  // Handle invite response
  const handleRespondInvite = async (inviteId: string, status: 'accepted' | 'declined') => {
    // Dismiss popup immediately (before async call)
    setPopupInvites(prev => prev.filter(i => i.id !== inviteId));

    const success = await inviteService.respond(inviteId, status);
    if (success) {
      setInvites(prev => prev.map(i => i.id === inviteId ? { ...i, status } : i));
      setNotifications(prev => prev.map(n => {
        if (n.inviteId === inviteId) {
          markNotifIdsAsRead([n.id]);
          return {
            ...n,
            inviteStatus: status,
            read: true,
            message: status === 'accepted' 
              ? n.message.replace('convidou-o', '✅ Aceite:')
              : n.message.replace('convidou-o', '❌ Recusado:'),
          };
        }
        return n;
      }));
    }
  };

  return (
    <div className="h-screen w-full flex flex-col justify-center bg-gradient-to-br from-[#f8f9fa] via-[#eef2f3] to-[#e6e9f0] overflow-hidden relative">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[99999] px-5 py-3 rounded-xl shadow-xl border text-sm font-semibold animate-fade-in-up flex items-center gap-2 max-w-[90vw] ${
          toast.type === 'error' ? 'bg-rose-50 border-rose-200 text-rose-700' :
          toast.type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-700' :
          'bg-emerald-50 border-emerald-200 text-emerald-700'
        }`}>
          <span>{toast.type === 'error' ? '❌' : toast.type === 'warning' ? '⚠️' : '✅'}</span>
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} className="ml-2 opacity-60 hover:opacity-100 transition-opacity">
            <X size={14} />
          </button>
        </div>
      )}
      {/* Decorative Blur Orbs - Global */}
      <div className="fixed top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-200/30 rounded-full blur-[120px] pointer-events-none z-0"></div>
      <div className="fixed bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-slate-300/30 rounded-full blur-[120px] pointer-events-none z-0"></div>

      {/* View Orchestration */}
      <div className="relative z-10 w-full h-full flex flex-col">
        
        {view === 'INTRO' && (
          <IntroScreen onStart={() => setView('AUTH')} />
        )}

        {view === 'AUTH' && (
          <AuthScreen 
            onSuccess={handleAuthSuccess} 
            onBack={() => setView('INTRO')} 
          />
        )}

        {view === 'APP' && (
           <div className="flex flex-col h-full p-3 sm:p-4 w-full max-w-[1400px] mx-auto animate-fade-in-up">
              {/* Top Bar with User Profile */}
              <div className="flex justify-between items-center mb-4 px-1">
                 <div>
                    <img 
                      src="/logo.png" 
                      alt="O Melro" 
                      className="h-12 w-auto object-contain drop-shadow-sm" 
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                 </div>

                 {user && (
                   <div className="flex items-center gap-3">
                      {/* Notifications */}
                      <div className="relative" ref={notifRef}>
                        <button
                          onClick={() => {
                            setShowNotifications(!showNotifications);
                          }}
                          className="relative w-8 h-8 flex items-center justify-center rounded-full bg-white hover:bg-slate-50 text-slate-500 transition-colors shadow-sm border border-white/60"
                          title="Notificações"
                        >
                          <Bell size={14} />
                          {unreadCount > 0 && (
                            <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center animate-pulse">
                              {unreadCount > 9 ? '9+' : unreadCount}
                            </span>
                          )}
                        </button>

                        {showNotifications && (
                          <div className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-80 bg-white rounded-xl shadow-2xl border border-slate-100 overflow-hidden z-50 animate-fade-in-up">
                            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50">
                              <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">Notificações</span>
                              {unreadCount > 0 && (
                                <button
                                  onClick={() => {
                                    markNotifIdsAsRead(notifications.map(n => n.id));
                                    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
                                  }}
                                  className="text-[10px] font-bold text-brand hover:underline"
                                >
                                  Marcar todas como lidas
                                </button>
                              )}
                            </div>
                            <div className="max-h-64 overflow-y-auto no-scrollbar">
                              {notifications.length === 0 ? (
                                <div className="p-6 text-center text-xs text-slate-400">
                                  Nenhuma notificação
                                </div>
                              ) : (
                                [...notifications].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).map(n => (
                                  <div
                                    key={n.id}
                                    className={`px-4 py-3 border-b border-slate-50 text-xs transition-colors ${!n.read ? 'bg-blue-50/50' : 'hover:bg-slate-50'}`}
                                    onClick={() => {
                                      markNotifIdsAsRead([n.id]);
                                      setNotifications(prev => prev.map(notif => notif.id === n.id ? { ...notif, read: true } : notif));
                                    }}
                                  >
                                    {n.type === 'invite' && (
                                      <div className="flex items-center gap-1 mb-1">
                                        <Users size={10} className="text-indigo-500" />
                                        <span className="text-[9px] font-bold text-indigo-500 uppercase tracking-wide">Convite</span>
                                      </div>
                                    )}
                                    <p className={`leading-relaxed ${!n.read ? 'font-bold text-slate-800' : 'text-slate-600'}`}>
                                      {n.message}
                                    </p>
                                    <p className="text-[10px] text-slate-400 mt-1">
                                      {n.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' })}
                                    </p>
                                    
                                    {/* Invite action buttons */}
                                    {n.type === 'invite' && n.inviteId && n.inviteStatus === 'pending' && (
                                      <div className="flex gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                                        <button
                                          onClick={() => handleRespondInvite(n.inviteId!, 'accepted')}
                                          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-brand text-white text-[10px] font-bold hover:bg-brand/90 transition-colors"
                                        >
                                          <Check size={10} />
                                          Aceitar
                                        </button>
                                        <button
                                          onClick={() => handleRespondInvite(n.inviteId!, 'declined')}
                                          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-white border border-rose-200 text-rose-500 text-[10px] font-bold hover:bg-rose-50 transition-colors"
                                        >
                                          <X size={10} />
                                          Recusar
                                        </button>
                                      </div>
                                    )}
                                    
                                    {n.type === 'invite' && n.inviteStatus === 'accepted' && (
                                      <div className="mt-2 flex items-center gap-1 text-[10px] font-bold text-brand">
                                        <Check size={10} />
                                        Aceite
                                      </div>
                                    )}
                                    
                                    {n.type === 'invite' && n.inviteStatus === 'declined' && (
                                      <div className="mt-2 flex items-center gap-1 text-[10px] font-bold text-rose-500">
                                        <X size={10} />
                                        Recusado
                                      </div>
                                    )}
                                    
                                    {n.type === 'invite' && n.inviteStatus === 'cancelled' && (
                                      <div className="mt-2 flex items-center gap-1 text-[10px] font-bold text-slate-500">
                                        🚫 Cancelado
                                      </div>
                                    )}
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* User Profile with Edit Name */}
                      <div className="flex items-center gap-3 bg-white/50 px-3 py-1.5 rounded-full border border-white/60 shadow-sm relative group">
                         <div className="w-6 h-6 rounded-full bg-slate-200 overflow-hidden">
                            {user.avatar ? (
                              <img src={user.avatar} alt={user.name} className="w-full h-full object-cover" />
                            ) : (
                              <UserIcon size={14} className="m-1 text-slate-500" />
                            )}
                         </div>
                         
                         {isEditingName ? (
                           <div className="flex items-center gap-1">
                             <input
                               type="text"
                               value={editNameValue}
                               onChange={(e) => setEditNameValue(e.target.value)}
                               onKeyDown={(e) => {
                                 if (e.key === 'Enter') handleChangeName();
                                 if (e.key === 'Escape') setIsEditingName(false);
                               }}
                               className="text-xs font-bold text-slate-700 bg-white border border-slate-200 rounded-md px-2 py-0.5 outline-none focus:border-brand w-24"
                               autoFocus
                             />
                             <button onClick={handleChangeName} className="text-brand hover:text-emerald-700">
                               <Check size={12} />
                             </button>
                             <button onClick={() => setIsEditingName(false)} className="text-slate-400 hover:text-slate-600">
                               <X size={12} />
                             </button>
                           </div>
                         ) : (
                           <button
                             onClick={() => {
                               setEditNameValue(user.name);
                               setIsEditingName(true);
                             }}
                             className="flex items-center gap-1 text-xs font-bold text-slate-700 truncate max-w-[100px] hover:text-brand transition-colors"
                             title="Clique para alterar o nome"
                           >
                             {user.name}
                             <Pencil size={10} className="text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                           </button>
                         )}
                      </div>
                      <button 
                        onClick={handleLogout}
                        className="w-8 h-8 flex items-center justify-center rounded-full bg-white hover:bg-rose-50 text-slate-400 hover:text-rose-500 transition-colors shadow-sm"
                        title="Sair"
                      >
                         <LogOut size={14} />
                      </button>
                   </div>
                 )}
              </div>

              <div className="flex-1 min-h-0 grid grid-cols-12 gap-4">
                <div className="col-span-12 h-full min-h-[400px]">
                  <WeeklyCalendar 
                      room={activeRoom}
                      rooms={processedRooms}
                      onSelectRoom={(id) => setActiveRoomId(id)}
                      onBookCurrent={() => handleBookRoom(activeRoom)}
                      bookings={activeRoomBookings}
                      currentDate={currentTime}
                      onDeleteBooking={handleDeleteBooking}
                      onRangeSelect={handleCalendarRangeSelect}
                      onEditBooking={handleEditBooking}
                      onLoadBookingInvites={(bookingId) => inviteService.getInvitesByBooking(bookingId)}
                  />
                </div>
              </div>
           </div>
        )}
      </div>

      {/* Invite Popup Modal */}
      {popupInvites.length > 0 && (
        <InvitePopup
          invites={popupInvites}
          onAccept={(id) => { handleRespondInvite(id, 'accepted'); }}
          onDecline={(id) => { handleRespondInvite(id, 'declined'); }}
          onDismiss={() => setPopupInvites([])}
        />
      )}

      {isBookingModalOpen && bookingRoom && (
        <BookingForm 
          room={bookingRoom} 
          currentUser={user}
          onClose={() => {
            setIsBookingModalOpen(false);
            setPrefilledBooking(null);
            setEditingBooking(null);
          }}
          onConfirm={confirmBooking}
          existingBookings={bookings.filter(b => b.roomId === bookingRoom.id)}
          initialValues={prefilledBooking}
          editingBooking={editingBooking}
          onUpdate={handleUpdateBooking}
          registeredUsers={registeredUsers}
        />
      )}
    </div>
  );
};

export default App;