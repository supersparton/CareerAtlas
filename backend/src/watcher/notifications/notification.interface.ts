export interface NotificationPayload {
  jobTitle: string;
  companyName: string;
  location: string;
  url: string;
  matchedRole?: string;
  matchedLocation?: string;
  matchedKeywords?: string[];
}

export interface NotificationProvider {
  name: string;
  sendAlert(userId: number, userEmail: string, payload: NotificationPayload): Promise<void>;
}
