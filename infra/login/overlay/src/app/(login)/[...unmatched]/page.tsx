import { notFound } from 'next/navigation';

// Routes the login does not own land here so the 404 renders inside the (login) layout (light-locked shell).
export default function Page() {
  notFound();
}
