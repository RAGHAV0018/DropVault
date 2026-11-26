# DropVault 🚀

DropVault is a zero-login, cross-device real-time file and clipboard sharing web application (AirDrop for the web). Devices pair instantly using 4-digit numeric room codes or QR codes to transfer files peer-to-peer over WebRTC data channels and synchronize notes in real time.

---

## ✨ Features

- **Zero-Login & Instant Pairing**: Pair devices using 4-digit room codes or scannable QR codes without accounts or passwords.
- **P2P Chunked File Transfer**: High-speed, encrypted peer-to-peer file transfer over WebRTC (`RTCDataChannel`), bypassing the server entirely for large files.
- **Backpressure & Flow Control**: Managed memory buffers via `bufferedAmount` and `bufferedamountlow` to prevent tab crashes on high-speed networks.
- **Live Collaborative Clipboard**: Instant note and link sharing synced over Socket.io, with debounced persistence to MongoDB Atlas.
- **Automatic Link Detection**: Automatically parses and extracts HTTP/HTTPS URLs with one-click copy and open capabilities.
- **TTL Auto-Expiry**: Temporary MongoDB Atlas clips automatically self-delete after 10 minutes using native MongoDB TTL indexes.
- **Responsive Mobile & Desktop UI**: Clean minimalist interface built with React, Vite, and Tailwind CSS.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, Vite, Tailwind CSS v4, Socket.io-client, `qrcode.react`
- **Backend**: Node.js, Express 5, Socket.io 4.8
- **Database**: MongoDB Atlas (Mongoose ODM with TTL index)
- **Networking**: WebRTC (Google public STUN servers for NAT traversal), WebSockets, SCTP

---

## 🚀 Getting Started

### Prerequisites

- Node.js (v18+)
- MongoDB Atlas cluster URI (or local MongoDB)

### 1. Clone & Install Dependencies

```bash
# Install backend dependencies
npm install

# Install frontend dependencies
cd frontend
npm install
cd ..
```

### 2. Environment Configuration

Copy `.env.example` to `.env` in the root:

```bash
cp .env.example .env
```

Configure your environment variables in `.env`:

```env
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
MONGO_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/dropvault?retryWrites=true&w=majority
```

### 3. Run Locally

Run the backend server:

```bash
node server.js
```

In a separate terminal, run the frontend development server:

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173` in your browser.

---

## 📦 Production Deployment

- **Backend**: Deploy on [Render](https://render.com) as a Web Service (`node server.js`).
- **Frontend**: Deploy on [Vercel](https://vercel.com) connecting the `frontend` directory.

See `DEPLOYMENT_GUIDE.txt` for detailed step-by-step instructions.

---

## 📄 License

MIT License.
