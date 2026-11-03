/* SPDX-License-Identifier: MIT
 *
 * Copyright (C) 2017-2025 WireGuard LLC. All Rights Reserved.
 */

package device

const (
	QueueStagedSize            = 128
	QueueOutboundSize          = 1024
	QueueInboundSize           = 1024
	QueueHandshakeSize         = 1024
	MaxSegmentSize             = (1 << 16) - 1 // In-memory packet links can exceed the Windows Wintun frame size.
	PreallocatedBuffersPerPool = 0         // Disable and allow for infinite memory growth
)
