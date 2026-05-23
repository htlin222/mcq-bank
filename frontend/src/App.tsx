import { Routes, Route, Link, NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  Home as HomeIcon,
  BookOpen,
  PenLine,
  Bookmark,
  Search as SearchIcon,
} from 'lucide-react';
import { useMe } from './hooks/useMe';
import { Avatar } from './components/Avatar';
import { NotificationBell } from './components/NotificationBell';
import { OnlineUsers } from './components/OnlineUsers';
import { ThemeToggle } from './components/ThemeToggle';
import { Home } from './routes/Home';
import { ReviewIndex } from './routes/ReviewIndex';
import { YearList } from './routes/YearList';
import { Question } from './routes/Question';
import { Exam } from './routes/Exam';
import { ExamResult } from './routes/ExamResult';
import { ExamHistory } from './routes/ExamHistory';
import { Profile } from './routes/Profile';
import { WrongQuestions } from './routes/Lists';
import { Bookmarks } from './routes/Bookmarks';
import { Search } from './routes/Search';

export default function App() {
  const { me } = useMe();

  return (
    <div className="min-h-screen bg-ink-50 dark:bg-ink-900 text-ink-800 dark:text-ink-200 flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-20 bg-white/95 dark:bg-ink-800/95 backdrop-blur border-b border-ink-200 dark:border-ink-700">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <Link to="/" className="font-serif text-xl text-ink-900 dark:text-ink-100 hover:text-accent transition whitespace-nowrap">
            血專衝衝衝
          </Link>

          {/* Desktop nav */}
          <nav className="hidden sm:flex gap-1 ml-6 text-sm">
            <NavItem to="/" end>首頁</NavItem>
            <NavItem to="/review">複習</NavItem>
            <NavItem to="/exam">全真</NavItem>
            <NavItem to="/search">搜尋</NavItem>
            <NavItem to="/bookmarks">收藏</NavItem>
            <NavItem to="/wrong">錯題</NavItem>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <OnlineUsers />
            <ThemeToggle />
            <NotificationBell />
            {me && (
              <Link
                to="/profile"
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-ink-100 dark:hover:bg-ink-800"
              >
                <Avatar
                  email={me.email}
                  avatarKey={me.avatar_key}
                  name={me.display_name}
                  size={28}
                />
                <span className="hidden sm:inline text-sm text-ink-700 dark:text-ink-200">
                  {me.display_name}
                </span>
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/review" element={<ReviewIndex />} />
          <Route path="/year/:year" element={<YearList />} />
          <Route path="/q/:id" element={<Question />} />
          <Route path="/exam" element={<Exam />} />
          <Route path="/exam/:sid" element={<Exam />} />
          <Route path="/exam/:sid/result" element={<ExamResult />} />
          <Route path="/exam-history" element={<ExamHistory />} />
          <Route path="/search" element={<Search />} />
          <Route path="/bookmarks" element={<Bookmarks />} />
          <Route path="/wrong" element={<WrongQuestions />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      {/* Mobile bottom nav */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-ink-800 border-t border-ink-200 dark:border-ink-700 grid grid-cols-5 z-20 safe-bottom">
        <BottomItem to="/" Icon={HomeIcon} label="首頁" end />
        <BottomItem to="/review" Icon={BookOpen} label="複習" />
        <BottomItem to="/exam" Icon={PenLine} label="全真" />
        <BottomItem to="/search" Icon={SearchIcon} label="搜尋" />
        <BottomItem to="/bookmarks" Icon={Bookmark} label="收藏" />
      </nav>
    </div>
  );
}

function NavItem({
  to,
  end,
  children,
}: {
  to: string;
  end?: boolean;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `px-3 py-1.5 rounded transition ${
          isActive
            ? 'text-accent font-medium'
            : 'text-ink-600 hover:text-ink-900 hover:bg-ink-100'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function BottomItem({
  to,
  Icon,
  label,
  end,
}: {
  to: string;
  Icon: LucideIcon;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex flex-col items-center justify-center py-2 text-[11px] gap-0.5 ${
          isActive ? 'text-accent' : 'text-ink-500'
        }`
      }
    >
      <Icon size={20} />
      <span>{label}</span>
    </NavLink>
  );
}

function NotFound() {
  return (
    <div className="max-w-md mx-auto px-4 py-20 text-center">
      <h1 className="font-serif text-4xl text-ink-900 mb-3">404</h1>
      <p className="text-ink-500">找不到頁面</p>
      <Link to="/" className="text-accent hover:text-accent-dark text-sm mt-4 inline-block">
        回首頁
      </Link>
    </div>
  );
}
