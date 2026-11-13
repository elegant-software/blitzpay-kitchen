<#import "template.ftl" as layout>
<#assign credentialsInvalid = messagesPerField.existsError('username', 'password')>
<@layout.registrationLayout displayMessage=!credentialsInvalid displayInfo=false; section>
    <#if section = "header">
        <span class="kitchen-eyebrow">${msg("kitchenScreen")}</span>
        ${msg("kitchenWelcome")}
    <#elseif section = "form">
        <p class="kitchen-intro">${msg("kitchenIntro")}</p>
        <#if realm.password>
            <form id="kc-form-login" action="${url.loginAction}" method="post">
                <#if !usernameHidden??>
                    <div class="form-group">
                        <label for="username">${msg("username")}</label>
                        <input id="username" name="username" type="text" value="${(login.username!'')}"
                               autocomplete="username" autocapitalize="none" spellcheck="false" dir="ltr" autofocus
                               aria-invalid="${credentialsInvalid?c}" <#if credentialsInvalid>aria-describedby="input-error"</#if> required>
                    </div>
                </#if>
                <div class="form-group">
                    <label for="password">${msg("password")}</label>
                    <div class="kitchen-password">
                        <input id="password" name="password" type="password" autocomplete="current-password" dir="ltr"
                               <#if usernameHidden??>autofocus</#if>
                               aria-invalid="${credentialsInvalid?c}" <#if credentialsInvalid>aria-describedby="input-error"</#if> required>
                        <button id="kitchen-password-toggle" type="button" aria-controls="password" aria-pressed="false"
                                data-show="${msg('showPassword')}" data-hide="${msg('hidePassword')}" hidden>
                            ${msg("showPassword")}
                        </button>
                    </div>
                    <#if credentialsInvalid>
                        <span id="input-error" class="kitchen-error" aria-live="polite">
                            ${kcSanitize(messagesPerField.getFirstError('username', 'password'))?no_esc}
                        </span>
                    </#if>
                </div>
                <input type="hidden" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>>
                <button id="kc-login" name="login" type="submit" data-submitting="${msg('kitchenSigningIn')}">
                    <span>${msg("doLogIn")}</span><span class="kitchen-arrow" aria-hidden="true">→</span>
                </button>
            </form>
        <#else>
            <p class="kitchen-error" role="alert">${msg("kitchenPasswordUnavailable")}</p>
        </#if>
        <div class="kitchen-help">
            <span class="kitchen-help-icon" aria-hidden="true">i</span>
            <p><strong>${msg("kitchenNeedAccess")}</strong><br>${msg("kitchenManagerHelp")}</p>
        </div>
    </#if>
</@layout.registrationLayout>
