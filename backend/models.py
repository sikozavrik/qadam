from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    full_name = Column(String(100), nullable=False)
    phone = Column(String(20), unique=True, nullable=False)
    password_hash = Column(Text, nullable=False)
    role = Column(String(20), default="user")
    subscription_active = Column(Boolean, default=False)
    subscription_until = Column(DateTime, nullable=True)
    is_frozen = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class Studio(Base):
    __tablename__ = "studios"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(150), nullable=False)
    category = Column(String(50), nullable=False)
    address = Column(Text, nullable=False)
    description = Column(Text)
    image_url = Column(Text)

class Workout(Base):
    __tablename__ = "workouts"
    id = Column(Integer, primary_key=True, index=True)
    studio_id = Column(Integer, ForeignKey("studios.id", ondelete="CASCADE"))
    title = Column(String(150), nullable=False)
    trainer_name = Column(String(100))
    start_time = Column(DateTime, nullable=False)
    duration_minutes = Column(Integer, default=60)
    max_spots = Column(Integer, nullable=False)
    booked_spots = Column(Integer, default=0)

class Booking(Base):
    __tablename__ = "bookings"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"))
    workout_id = Column(Integer, ForeignKey("workouts.id", ondelete="CASCADE"))
    status = Column(String(20), default="confirmed")
    qr_code = Column(String(100), unique=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)