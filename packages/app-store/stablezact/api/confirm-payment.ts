import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";

import prisma from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";

import { appKeysSchema } from "../zod";

/**
 * Confirm payment from frontend after Stablezact SDK onSuccess callback
 * IMPORTANT: Verifies payment status with Stablezact API before marking booking as paid
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { bookingId, paymentId, transactionHash } = req.body;

    // Validate required fields
    if (!bookingId || !paymentId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Find the payment record and associated booking
    const payment = await prisma.payment.findFirst({
      where: {
        bookingId: parseInt(bookingId),
        appId: "stablezact",
      },
      select: {
        id: true,
        data: true,
        booking: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    // Check if booking exists and has a user
    if (!payment.booking || !payment.booking.userId) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // Get merchant credentials to verify payment with Stablezact API
    const credential = await prisma.credential.findFirst({
      where: {
        appId: "stablezact",
        userId: payment.booking.userId,
      },
      select: {
        key: true,
      },
    });

    if (!credential) {
      return res.status(400).json({ error: "Merchant credentials not found" });
    }

    // Validate credentials format (not used for public endpoint, but validates merchant setup)
    const _credentials = appKeysSchema.parse(credential.key);

    // Verify payment status with Stablezact API
    // API URL is configured via environment variable
    const baseURL = process.env.STABLEZACT_API_URL || "https://hub.stablezact.com";
    const apiUrl = baseURL.endsWith("/api") ? baseURL : `${baseURL}/api`;

    try {
      // Verify payment status using public endpoint
      const statusResponse = await axios.get(`${apiUrl}/payments/public/${paymentId}`, {
        timeout: 10000,
      });

      const paymentData = statusResponse.data?.payment;
      const paymentStatus = paymentData?.status;

      // Only mark as paid if Stablezact confirms payment is successful
      if (paymentStatus !== "confirmed" && paymentStatus !== "completed") {
        return res.status(400).json({
          error: "Payment not confirmed",
          status: paymentStatus,
        });
      }

      // SECURITY: Verify the payment was created for this specific booking.
      // PaymentService always sets metadata.bookingId at creation, so require it
      // and compare unconditionally — a missing bookingId must be rejected, not
      // skipped, or a confirmed paymentId from another context could confirm any booking.
      const paymentMetadata = paymentData?.metadata;
      const metadataBookingId = paymentMetadata?.bookingId?.toString();

      if (!metadataBookingId || metadataBookingId !== bookingId.toString()) {
        return res.status(403).json({ error: "Payment does not belong to this booking" });
      }
    } catch {
      return res.status(500).json({
        error: "Failed to verify payment status",
      });
    }

    // Update payment record
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        success: true,
        externalId: paymentId,
        data: {
          ...(payment.data as object),
          transactionHash,
          status: "confirmed",
          confirmedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // Mark booking as paid
    await prisma.booking.update({
      where: { id: parseInt(bookingId) },
      data: {
        paid: true,
        status: "ACCEPTED",
      },
    });

    return res.status(200).json({
      success: true,
      message: "Payment confirmed",
    });
  } catch {
    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
