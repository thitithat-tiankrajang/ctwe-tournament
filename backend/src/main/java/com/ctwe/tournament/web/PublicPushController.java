package com.ctwe.tournament.web;

import com.ctwe.tournament.application.WebPushService;
import com.ctwe.tournament.web.dto.PushDtos;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.concurrent.TimeUnit;

@RestController
@RequestMapping("/api/public/push")
public class PublicPushController {
    private final WebPushService push;

    public PublicPushController(WebPushService push) {
        this.push = push;
    }

    @GetMapping("/config")
    public ResponseEntity<PushDtos.ConfigResponse> config() {
        return ResponseEntity.ok()
            .cacheControl(CacheControl.maxAge(5, TimeUnit.MINUTES).cachePublic())
            .body(push.config());
    }

    @PostMapping("/subscriptions")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void subscribe(@Valid @RequestBody PushDtos.SubscribeRequest request) {
        push.subscribe(request);
    }

    @DeleteMapping("/subscriptions")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void unsubscribe(@Valid @RequestBody PushDtos.UnsubscribeRequest request) {
        push.unsubscribe(request);
    }

    @PostMapping("/subscriptions/refresh")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void refresh(@Valid @RequestBody PushDtos.RefreshRequest request) {
        push.refresh(request);
    }
}
