import axios from 'axios';
import Cookies from 'js-cookie';

export type ToastLike = {
  success: (message: string) => void;
  error: (message: string) => void;
};

export type NavigateFn = (path: string, options?: any) => any;

export type UserData = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  username: string;
  company: string;
  email_validated: string;
  user_active: string;
  user_gid: string;
};

export class UserSessionService {
  email: string | null;
  session_gid: string | null;

  apiUrl: string;
  imageApi: string;
  fileApi: string;

  user_gid: string | null;
  accessList: any[];
  profileImageUrl: string | null;
  profileImageBase64: string | null;

  constructor(email: string | null = null, session_gid: string | null = null) {
    this.email = email || Cookies.get('user_email') || null;
    this.session_gid = session_gid || Cookies.get('session_gid') || null;

    this.apiUrl = 'https://auth-api-frankfurt.onrender.com/auth';
    this.imageApi = 'https://auth-api-frankfurt.onrender.com/images';
    this.fileApi = 'https://auth-api-frankfurt.onrender.com/attachments';

    this.user_gid = null;
    this.accessList = [];
    this.profileImageUrl = null;
    this.profileImageBase64 = null;
  }

  private async post<T = any>(path: string, body?: any): Promise<T> {
    const { data } = await axios.post(`${this.apiUrl}${path}`, body, { timeout: 20000 });
    return data as T;
  }

  private async get<T = any>(path: string, params?: Record<string, any>): Promise<T> {
    const { data } = await axios.get(`${this.apiUrl}${path}`, { params, timeout: 20000 });
    return data as T;
  }

  async login(payload: any): Promise<any> {
    return this.post('/login', payload);
  }

  async register(payload: any): Promise<any> {
    return this.post('/register', payload);
  }

  async loggedIn(payload: any): Promise<any> {
    return this.post('/logged-in', payload);
  }

  async logout(): Promise<boolean> {
    if (!this.session_gid) return false;

    const data: any = await this.post('/logout', {
      session_gid: this.session_gid
    });

    if (data?.response === '_S') {
      Cookies.remove('session_gid');
      Cookies.remove('user_email');
      return true;
    }

    throw new Error('Logout failed');
  }

  async handleSignOut(navigate: NavigateFn, toast?: ToastLike): Promise<boolean> {
    try {
      if (!this.session_gid) {
        toast?.error('No session found. Redirecting to dashboard.');
        navigate('/');
        return false;
      }

      const data: any = await this.post('/logout', {
        session_gid: this.session_gid
      });

      if (data?.response === '_S') {
        Cookies.remove('session_gid');
        Cookies.remove('user_email');
        toast?.success('Successfully signed out.');
        navigate('/', { replace: true });
        return true;
      }

      toast?.error('Sign-out failed. Please try again.');
      return false;
    } catch (error) {
      toast?.error('An error occurred during sign-out.');
      console.error(error);
      return false;
    }
  }

  async status(payload: any): Promise<any> {
    return this.post('/status', payload);
  }

  async fetchUserStatus(): Promise<string> {
    if (!this.email) throw new Error('Email is required to fetch user ID');

    const data: any = await this.post('/status', { email: this.email });

    if (data?.user_gid) {
      this.user_gid = String(data.user_gid);
      return this.user_gid;
    }

    throw new Error('User GID not found in response');
  }

  async fetchUserData(): Promise<UserData | null> {
    const user_email = Cookies.get('user_email') || '';

    try {
      const data: any = await this.post('/status', { email: user_email });

      if (data?.response === '_S') {
        return {
          first_name: data.first_name || '',
          last_name: data.last_name || '',
          email: data.email || '',
          phone: data.phone || '',
          username: data.username || '',
          company: data.company || '',
          email_validated: data.email_validated || 'false',
          user_active: data.user_active || 'inactive',
          user_gid: data.user_gid || ''
        };
      }

      return null;
    } catch (error) {
      console.error('Error fetching profile:', error);
      return null;
    }
  }

  async fetchAccessList(): Promise<any[]> {
    if (!this.session_gid) throw new Error('Session GID is missing');

    const data: any = await this.post('/access', {
      session_gid: this.session_gid
    });

    this.accessList = data?.utility_list || [];
    return this.accessList;
  }

  async fetchProfileImageURL(): Promise<string | null> {
    if (!this.session_gid) return null;

    try {
      const res = await fetch(`https://auth-api-frankfurt.onrender.com/fetch-profile/${this.session_gid}`, {
        method: 'GET'
      });

      if (!res.ok) return null;

      const data: any = await res.json();

      if (!data?.image_base64) return null;

      const mimeType = data.mime_type || 'image/jpeg';
      const base64URL = `data:${mimeType};base64,${data.image_base64}`;
      this.profileImageBase64 = base64URL;
      return base64URL;
    } catch {
      return null;
    }
  }

  isLoggedIn(): boolean {
    return Boolean(this.session_gid);
  }

  getSession(): string | null {
    return this.session_gid;
  }

  getUserId(): string | null {
    return this.user_gid;
  }

  getUserAccess(): any[] {
    return this.accessList;
  }
}
